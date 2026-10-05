// The console's conversations and their claude processes (docs/ARCHITECTURE.md, "Backend" → "Console"; decisions:
// docs/PLAN.md, "Backend decisions (stage 3)"). A singleton, because a hub instance lives for one call. Every change of
// a conversation and every event it sends happen under the conversation's lock, so all connections and a later replay
// see one order. Replies to the API's own control requests are matched without that lock, so a prompt waiting for them
// never blocks the reader that reads them. Also the hosted service that prepares the CLI's config directory and ends
// the turns a stopped API left open at start, closes idle processes every minute and stops every process on a stop
// (never for create-user, which exits before the host runs).
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Text;
using System.Text.Json;
using Claushh.Api.Files;
using Claushh.Api.Git;
using Claushh.Api.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Claude;

// GetConversation's result: the project's latest conversation as its events (none: null and no events).
public sealed record ConversationSnapshot(string? ConversationId, IReadOnlyList<JsonElement> Events);

public sealed class Conversations(ClaudeCli cli, ConversationLog store, ProjectPaths paths, Repositories repositories,
    IHubContext<ConsoleHub> hub, TimeProvider clock, ILogger<Conversations> log) : IHostedService
{
    public const string InvalidPath = "Invalid path";
    public const string UnknownConversation = "Unknown conversation";
    public const string BusyConversation = "Conversation is busy";
    public const string TooMany = "Too many active conversations";
    public const string NoRule = "This question has no rule to save";
    public const int ProcessLimit = 8;
    public static readonly TimeSpan IdleTimeout = TimeSpan.FromMinutes(15);
    public static readonly TimeSpan DefaultInterruptTimeout = TimeSpan.FromSeconds(10);

    private const string Interrupted = "interrupted";
    private const string ResumeFailed = "Could not resume the conversation. Start a new one (“New”).";
    private const string StoppedMidTurn = "The server stopped during the turn.";
    // How long a closed process may take to exit before its tree is killed; also the whole stop's limit.
    private static readonly TimeSpan CloseWait = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan IdleSweep = TimeSpan.FromMinutes(1);

    private readonly ConcurrentDictionary<Guid, ConversationState> _states = new();
    // Every started process with its reader, until the reader has handled its exit.
    private readonly ConcurrentDictionary<ClaudeProcess, Task> _running = new();
    // Held while a launch counts the live processes and frees a slot, so two launches never take the same one.
    private readonly SemaphoreSlim _launch = new(1, 1);
    private readonly CancellationTokenSource _stopping = new();
    private Task _sweep = Task.CompletedTask;
    private volatile bool _stopped;

    // How long an interrupted turn may run on before its process tree is killed; the tests shorten it, and CloseAllAsync
    // restores it.
    public TimeSpan InterruptTimeout { get; set; } = DefaultInterruptTimeout;

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        cli.PrepareDirectory();
        await RecoverAsync();
        _sweep = SweepAsync(_stopping.Token);
    }

    // Open turns are interrupted and every stdin is closed; whatever still runs after 5 s is killed. A turn that ends
    // meanwhile ends as interrupted (ReadAsync).
    public async Task StopAsync(CancellationToken cancellationToken)
    {
        _stopped = true;
        await _stopping.CancelAsync();
        await _sweep;
        var ending = new List<Task>();
        foreach (var state in _states.Values)
        {
            await state.Lock.WaitAsync();
            try
            {
                if (state.Process is { } process)
                {
                    var interrupt = state.Turn is { Interrupting: false };
                    if (state.Turn is { } turn)
                    {
                        turn.Interrupting = true;
                        await DenyPendingAsync(state, turn);
                    }
                    ending.Add(EndAsync(process, interrupt));
                }
            }
            finally
            {
                state.Lock.Release();
            }
        }
        await WithinAsync(Task.WhenAll(ending), CloseWait);
        foreach (var process in _running.Keys)
        {
            process.KillTree();
        }
        await WithinAsync(Task.WhenAll(_running.Values), CloseWait);
    }

    // For the tests, before every test: every process is killed and every conversation in memory forgotten (the test
    // deletes the rows next); the events of their ends are stored before that.
    public async Task CloseAllAsync()
    {
        _states.Clear();
        foreach (var (process, reader) in _running.ToArray())
        {
            process.KillTree();
            await reader;
        }
        InterruptTimeout = DefaultInterruptTimeout;
    }

    // Whether the conversation has a live process (for the tests).
    public bool IsRunning(string conversationId) =>
        Guid.TryParse(conversationId, out var id) && _states.TryGetValue(id, out var state) && state.Process is not null;

    public async Task<ConversationSnapshot> GetAsync(string? projectPath)
    {
        _ = RealDirectory(projectPath);
        if (await store.LatestAsync(projectPath!) is not { } row)
        {
            return new ConversationSnapshot(null, []);
        }
        var state = Track(row);
        await state.Lock.WaitAsync();
        try
        {
            var events = (await store.EventsAsync(row.Id)).Select(Parse).ToList();
            if (state.OpenText is { } open)
            {
                events.Add(ConsoleEvents.Text(state.Key, open.MessageId, open.Text.ToString()));
            }
            return new ConversationSnapshot(state.Key, events);
        }
        finally
        {
            state.Lock.Release();
        }
    }

    public async Task<string> StartConversationAsync(string? projectPath)
    {
        _ = RealDirectory(projectPath);
        var row = await store.CreateAsync(projectPath!);
        var state = Track(row);
        await state.Lock.WaitAsync();
        try
        {
            state.NextSeq = 1;
            await EmitAsync(state, ConsoleEvents.Conversation(state.Key, row.ProjectPath, row.StartedAt));
        }
        finally
        {
            state.Lock.Release();
        }
        return state.Key;
    }

    // Launches or reuses the process, applies the options, stores and sends prompt and working, and writes the prompt;
    // the turn's events follow from the reader. The conversation is busy from here to the end of its turn.
    public async Task SendPromptAsync(string? conversationId, string text, PromptOptions options)
    {
        ConversationState state;
        while (true)
        {
            state = await FindAsync(conversationId) ?? throw new HubException(UnknownConversation);
            await state.Lock.WaitAsync();
            try
            {
                // Forgotten by the idle check meanwhile: the next lookup gives the conversation's current state.
                if (state.Forgotten)
                {
                    continue;
                }
                if (state.Busy)
                {
                    throw new HubException(BusyConversation);
                }
                state.Busy = true;
                state.LastUsed = clock.GetUtcNow();
                break;
            }
            finally
            {
                state.Lock.Release();
            }
        }
        var opened = false;
        try
        {
            var process = await EnsureProcessAsync(state, options);
            await process.ApplyAsync(options);
            // Outside the conversation's lock (LibGit2 can take a while on a large repository), before the prompt line.
            var before = FileChanges.Status(repositories, state.ProjectPath);
            await state.Lock.WaitAsync();
            try
            {
                // The process ended while its options were applied: no reader is left to end a turn.
                if (state.Process != process)
                {
                    throw new HubException(ClaudeProcess.Unresponsive);
                }
                state.Turn = new Turn(state.WorkingDirectory) { Before = before };
                opened = true;
                await EmitAsync(state, ConsoleEvents.Prompt(state.Key, text));
                await EmitAsync(state, ConsoleEvents.Status(state.Key, "working"));
            }
            finally
            {
                state.Lock.Release();
            }
            try
            {
                await process.SendPromptAsync(text);
            }
            catch (HubException)
            {
                // The prompt never reached the CLI: its process goes, and the reader ends the turn with an error.
                process.KillTree();
                throw;
            }
        }
        catch when (!opened)
        {
            await state.Lock.WaitAsync();
            try
            {
                state.Busy = false;
            }
            finally
            {
                state.Lock.Release();
            }
            throw;
        }
    }

    // Open questions end as denied at once, then the CLI's interrupt; a turn without its result within
    // InterruptTimeout ends as interrupted and its process is killed. An unknown or idle conversation is a no-op.
    public async Task InterruptAsync(string? conversationId)
    {
        if (await FindAsync(conversationId) is not { } state)
        {
            return;
        }
        Turn turn;
        ClaudeProcess process;
        await state.Lock.WaitAsync();
        try
        {
            if (state.Turn is not { Interrupting: false } open || state.Process is not { } running)
            {
                return;
            }
            open.Interrupting = true;
            await DenyPendingAsync(state, open);
            turn = open;
            process = running;
        }
        finally
        {
            state.Lock.Release();
        }
        _ = WatchInterruptAsync(state, turn, process);
        try
        {
            await process.InterruptAsync();
        }
        catch (HubException e)
        {
            log.LogWarning(e, "Sending the interrupt of console conversation {Conversation} failed", state.Key);
        }
    }

    // The browser's answer. An unknown conversation or request, or one already answered, is silent: the first answer
    // wins. The answer is stored and sent before it is written, so the allowed tool's step always comes after it.
    public async Task AnswerPermissionAsync(string? conversationId, string? requestId, string decision)
    {
        if (requestId is null || await FindAsync(conversationId) is not { } state)
        {
            return;
        }
        PendingPermission pending;
        ClaudeProcess? process;
        await state.Lock.WaitAsync();
        try
        {
            if (state.Turn is not { } turn || !turn.Pending.TryGetValue(requestId, out var found))
            {
                return;
            }
            if (decision == "allow-always" && found.AlwaysRule is null)
            {
                throw new HubException(NoRule);
            }
            turn.Pending.Remove(requestId);
            pending = found;
            process = state.Process;
            await EmitAsync(state, ConsoleEvents.Resolved(state.Key, requestId, decision));
            if (turn.Pending.Count == 0)
            {
                await EmitAsync(state, ConsoleEvents.Status(state.Key, "working"));
            }
        }
        finally
        {
            state.Lock.Release();
        }
        if (decision == "allow-always")
        {
            try
            {
                await store.AddRuleAsync(state.ProjectPath, pending.AlwaysRule!);
            }
            catch (Exception e)
            {
                log.LogError(e, "Saving a rule of console conversation {Conversation} failed; the answer was still sent", state.Key);
            }
        }
        if (process is not null)
        {
            await process.ReplyAsync(pending.CliRequestId, PermissionRequests.Answer(pending, decision));
        }
    }

    // Processes without a turn for IdleTimeout get EOF on stdin and are killed 5 s later if they still run; the next
    // prompt resumes the conversation. A conversation with no process left (and none still closing) is forgotten after
    // IdleTimeout too: what it needs is in the database, which its next use reads again, so one that retention deleted
    // is then unknown. Every minute, and directly from the tests.
    public async Task CloseIdleAsync()
    {
        var now = clock.GetUtcNow();
        foreach (var state in _states.Values)
        {
            await state.Lock.WaitAsync();
            try
            {
                if (state.Busy || now - state.LastUsed < IdleTimeout)
                {
                    continue;
                }
                if (state.Process is { } process)
                {
                    state.Process = null;
                    state.Closing = process.CloseAsync(CloseWait);
                }
                else if (state.Closing.IsCompleted)
                {
                    state.Forgotten = true;
                    _states.TryRemove(new KeyValuePair<Guid, ConversationState>(state.Id, state));
                }
            }
            finally
            {
                state.Lock.Release();
            }
        }
    }

    // At start: a conversation whose log ends with working or waiting was cut off by a stop or a crash. Its open
    // questions end as denied, then an error, so a replay shows no dead question.
    public async Task RecoverAsync()
    {
        try
        {
            foreach (var id in await store.UnfinishedAsync())
            {
                if (await store.FindAsync(id) is not { } row)
                {
                    continue;
                }
                var state = Track(row);
                await state.Lock.WaitAsync();
                try
                {
                    var events = (await store.EventsAsync(id)).Select(Parse).ToList();
                    var answered = events.Where(e => StreamJson.Str(e, "type") == "permission-resolved")
                        .Select(e => StreamJson.Str(e, "requestId")).ToHashSet();
                    foreach (var question in events.Where(e => StreamJson.Str(e, "type") == "permission").Select(e => StreamJson.Str(e, "requestId")))
                    {
                        if (question is not null && !answered.Contains(question))
                        {
                            await EmitAsync(state, ConsoleEvents.Resolved(state.Key, question, "deny"));
                        }
                    }
                    await EmitAsync(state, ConsoleEvents.Status(state.Key, "error", StoppedMidTurn));
                }
                finally
                {
                    state.Lock.Release();
                }
            }
        }
        catch (Exception e)
        {
            log.LogError(e, "Ending the console turns a stopped API left open failed");
        }
    }

    // The conversation's process, launched (or resumed) when it has none. Called while the conversation is busy, so
    // nothing else launches for it at the same time.
    private async Task<ClaudeProcess> EnsureProcessAsync(ConversationState state, PromptOptions options)
    {
        if (state.Process is { } running)
        {
            return running;
        }
        await state.Closing;
        if (!await cli.EnsureAvailableAsync(CancellationToken.None))
        {
            throw new HubException(ClaudeCli.Unavailable);
        }
        var directory = RealDirectory(state.ProjectPath);
        await ReserveAsync(state);
        ClaudeProcess? process = null;
        try
        {
            var resume = state.Resumable;
            var started = ClaudeProcess.Start(
                cli.StartInfo(directory, cli.Arguments(state.Id, resume, options, await store.RulesAsync(state.ProjectPath))), log);
            process = started;
            await state.Lock.WaitAsync();
            try
            {
                state.Process = started;
                state.WorkingDirectory = directory;
            }
            finally
            {
                state.Lock.Release();
            }
            _running[started] = Task.Run(() => ReadAsync(state, started));
            try
            {
                await started.InitializeAsync();
            }
            catch (HubException) when (resume)
            {
                await state.Lock.WaitAsync();
                try
                {
                    await EmitAsync(state, ConsoleEvents.Status(state.Key, "error", ResumeFailed));
                }
                finally
                {
                    state.Lock.Release();
                }
                throw;
            }
            return started;
        }
        catch (Exception e) when (e is HubException or Win32Exception or InvalidOperationException or IOException)
        {
            log.LogWarning(e, "Starting claude for console conversation {Conversation} failed", state.Key);
            if (process is not null)
            {
                await state.Lock.WaitAsync();
                try
                {
                    if (state.Process == process)
                    {
                        state.Process = null;
                    }
                }
                finally
                {
                    state.Lock.Release();
                }
                process.KillTree();
            }
            throw new HubException(ClaudeCli.Unavailable);
        }
        finally
        {
            state.Launching = false;
        }
    }

    // A slot among the ProcessLimit live processes: free, or freed by closing the least recently used idle one.
    private async Task ReserveAsync(ConversationState state)
    {
        await _launch.WaitAsync();
        try
        {
            if (_stopped)
            {
                throw new HubException(ClaudeCli.Unavailable);
            }
            if (_states.Values.Count(s => s.Process is not null || s.Launching) >= ProcessLimit && !await CloseLeastRecentlyUsedAsync(state))
            {
                throw new HubException(TooMany);
            }
            state.Launching = true;
        }
        finally
        {
            _launch.Release();
        }
    }

    private async Task<bool> CloseLeastRecentlyUsedAsync(ConversationState except)
    {
        foreach (var candidate in _states.Values.Where(s => s != except && s.Process is not null && !s.Busy).OrderBy(s => s.LastUsed).ToList())
        {
            await candidate.Lock.WaitAsync();
            try
            {
                if (candidate.Busy || candidate.Process is not { } process)
                {
                    continue;
                }
                candidate.Process = null;
                candidate.Closing = process.CloseAsync(CloseWait);
                return true;
            }
            finally
            {
                candidate.Lock.Release();
            }
        }
        return false;
    }

    // One reader per process: each line is handled, its events stored and sent, before the next is read. At the end of
    // the output, a turn this process still had ends: as interrupted while the API stops, otherwise with an error.
    private async Task ReadAsync(ConversationState state, ClaudeProcess process)
    {
        try
        {
            while (true)
            {
                JsonElement? line;
                try
                {
                    line = await process.ReadLineAsync();
                }
                catch (JsonException e)
                {
                    log.LogWarning(e, "claude wrote a line that is not JSON in console conversation {Conversation}", state.Key);
                    continue;
                }
                if (line is not { } value)
                {
                    break;
                }
                await HandleAsync(state, process, value);
            }
        }
        catch (Exception e)
        {
            // A line over 16 MB, or a failure while handling one: the process cannot go on.
            log.LogWarning(e, "Reading claude's output in console conversation {Conversation} failed; its process is killed", state.Key);
            process.KillTree();
        }
        try
        {
            var code = await process.ExitAsync();
            log.LogInformation("claude of console conversation {Conversation} exited with {ExitCode}", state.Key, code);
            await state.Lock.WaitAsync();
            try
            {
                if (state.Process == process)
                {
                    state.Process = null;
                    if (state.Turn is { } turn)
                    {
                        // A process that ends during an interrupt or a stop ends its turn as interrupted.
                        await EndTurnAsync(state, _stopped || turn.Interrupting
                            ? ConsoleEvents.Status(state.Key, "idle", Interrupted)
                            : ConsoleEvents.Status(state.Key, "error", $"The console process exited (code {code})."));
                    }
                }
            }
            finally
            {
                state.Lock.Release();
            }
        }
        catch (Exception e)
        {
            log.LogError(e, "Ending the claude process of console conversation {Conversation} failed", state.Key);
        }
        finally
        {
            _running.TryRemove(process, out _);
        }
    }

    // One line. Control replies complete the API's own requests without the lock; everything else is handled under it,
    // and only while this process is the conversation's.
    private async Task HandleAsync(ConversationState state, ClaudeProcess process, JsonElement line)
    {
        var type = StreamJson.Str(line, "type");
        if (type == "control_response")
        {
            process.Complete(line);
            return;
        }
        await state.Lock.WaitAsync();
        try
        {
            if (state.Process != process)
            {
                return;
            }
            if (type == "control_request")
            {
                await OnControlRequestAsync(state, process, line);
            }
            else if (type == "control_cancel_request")
            {
                await OnCancelAsync(state, line);
            }
            else if (type == "system")
            {
                await OnSystemAsync(state, line);
            }
            else if (state.Turn is { } turn)
            {
                switch (type)
                {
                    case "stream_event":
                        await OnStreamEventAsync(state, turn, line);
                        break;
                    case "assistant":
                        OnAssistant(turn, line);
                        break;
                    case "user":
                        await OnUserAsync(state, turn, line);
                        break;
                    case "result":
                        await OnResultAsync(state, turn, line);
                        break;
                }
            }
        }
        finally
        {
            state.Lock.Release();
        }
    }

    // Every control request of the CLI is answered, or the CLI waits for ever; one the console does not support gets an
    // error reply.
    private async Task OnControlRequestAsync(ConversationState state, ClaudeProcess process, JsonElement line)
    {
        var requestId = StreamJson.Str(line, "request_id") ?? "";
        var request = StreamJson.Get(line, "request") ?? default;
        var subtype = StreamJson.Str(request, "subtype");
        if (subtype == "can_use_tool" && state.Turn is { } turn)
        {
            await AskAsync(state, turn, requestId, request);
            return;
        }
        log.LogWarning("claude sent the control request {Subtype}, which the console does not support, in conversation {Conversation}",
            subtype, state.Key);
        await process.ReplyErrorAsync(requestId, $"Unsupported control request: {subtype}");
    }

    // A question of the CLI: the server's own requestId, what it is for, and the one rule allow-always may save; then the
    // conversation waits. A question has no time limit.
    private async Task AskAsync(ConversationState state, Turn turn, string cliRequestId, JsonElement request)
    {
        var tool = StreamJson.Str(request, "tool_name") ?? "";
        var input = StreamJson.Get(request, "input") ?? default;
        var (rule, alwaysRule) = PermissionRequests.Rule(request);
        var requestId = Guid.NewGuid().ToString("D");
        turn.Pending[requestId] = new PendingPermission(cliRequestId, tool, input, rule, alwaysRule);
        await EmitAsync(state, ConsoleEvents.Permission(state.Key, requestId, PermissionRequests.Description(tool, input, turn.Directory), alwaysRule));
        await EmitAsync(state, ConsoleEvents.Status(state.Key, "waiting"));
    }

    // The CLI no longer needs an answer (control_cancel_request): the question ends as denied.
    private async Task OnCancelAsync(ConversationState state, JsonElement line)
    {
        if (state.Turn is not { } turn || StreamJson.Str(line, "request_id") is not { } cliRequestId)
        {
            return;
        }
        foreach (var requestId in turn.Pending.Where(entry => entry.Value.CliRequestId == cliRequestId).Select(entry => entry.Key).ToList())
        {
            turn.Pending.Remove(requestId);
            await EmitAsync(state, ConsoleEvents.Resolved(state.Key, requestId, "deny"));
            if (turn.Pending.Count == 0 && !turn.Interrupting)
            {
                await EmitAsync(state, ConsoleEvents.Status(state.Key, "working"));
            }
        }
    }

    // init: the CLI knows the conversation's id as its session, so the next process resumes it. permission_denied: a
    // tool the CLI refused on its own, without a question (--restricted, e.g. a file outside the directory), is a step of
    // kind other with the CLI's reason as its error output; its tool_result then adds nothing.
    private async Task OnSystemAsync(ConversationState state, JsonElement line)
    {
        var subtype = StreamJson.Str(line, "subtype");
        if (subtype == "init" && !state.Resumable && StreamJson.Str(line, "session_id") == state.Key)
        {
            state.Resumable = true;
            try
            {
                await store.MarkResumableAsync(state.Id);
            }
            catch (Exception e)
            {
                log.LogError(e, "Marking console conversation {Conversation} as resumable failed", state.Key);
            }
            return;
        }
        if (subtype != "permission_denied" || state.Turn is not { } turn || StreamJson.Str(line, "tool_use_id") is not { } id
            || !turn.Tools.Remove(id, out var tool) || StreamJson.Kind(tool.Name, null) is null)
        {
            return;
        }
        await EmitAsync(state, ConsoleEvents.Step(state.Key, id, "other", StreamJson.Target(tool.Name, tool.Input, turn.Directory)));
        await EmitAsync(state, ConsoleEvents.StepOutput(state.Key, id,
            StreamJson.Str(line, "message") ?? StreamJson.Str(line, "decision_reason") ?? "", true));
    }

    // Text deltas of the conversation's own messages. A text block's messageId is "<message id>:<block index>", so text
    // after a tool in the same message starts a new entry. Thinking is not shown.
    private async Task OnStreamEventAsync(ConversationState state, Turn turn, JsonElement line)
    {
        if (!StreamJson.TopLevel(line) || StreamJson.Get(line, "event") is not { } streamEvent)
        {
            return;
        }
        var type = StreamJson.Str(streamEvent, "type");
        if (type == "message_start")
        {
            turn.MessageId = StreamJson.Get(streamEvent, "message") is { } message ? StreamJson.Str(message, "id") ?? "" : "";
        }
        else if (type == "content_block_delta" && StreamJson.Get(streamEvent, "delta") is { } delta
            && StreamJson.Str(delta, "type") == "text_delta" && StreamJson.Str(delta, "text") is { Length: > 0 } text)
        {
            var index = StreamJson.Get(streamEvent, "index") is { ValueKind: JsonValueKind.Number } number ? number.GetInt32() : 0;
            await EmitAsync(state, ConsoleEvents.Text(state.Key, $"{turn.MessageId}:{index}", text));
        }
    }

    // Complete tool_use blocks: what a step needs once its result arrives.
    private static void OnAssistant(Turn turn, JsonElement line)
    {
        if (!StreamJson.TopLevel(line))
        {
            return;
        }
        foreach (var block in StreamJson.Content(line))
        {
            if (StreamJson.Str(block, "type") == "tool_use" && StreamJson.Str(block, "id") is { } id
                && StreamJson.Str(block, "name") is { } name)
            {
                turn.Tools[id] = (name, StreamJson.Get(block, "input") ?? default);
            }
        }
    }

    // A tool_result: the step of a tool that ran; a tool that did not run (denied, refused, cancelled) has none.
    private async Task OnUserAsync(ConversationState state, Turn turn, JsonElement line)
    {
        if (!StreamJson.TopLevel(line))
        {
            return;
        }
        var results = StreamJson.Content(line).Where(block => StreamJson.Str(block, "type") == "tool_result").ToList();
        // The structured result belongs to the line; the CLI writes one tool_result per line.
        var structured = results.Count == 1 ? StreamJson.Get(line, "tool_use_result") : null;
        foreach (var block in results)
        {
            if (StreamJson.Str(block, "tool_use_id") is not { } id || !turn.Tools.Remove(id, out var tool)
                || StreamJson.NotExecuted(line, id) || StreamJson.Kind(tool.Name, structured) is not { } kind)
            {
                continue;
            }
            foreach (var e in StepOf(state, turn, id, tool, kind, block, structured))
            {
                await EmitAsync(state, e);
            }
        }
    }

    // The events of a tool that ran: its step (an edit with its counts), its output (capped), and for an edit the file it
    // changed, relative to the projects directory. A command marks the turn for the status diff at its end.
    private IEnumerable<JsonElement> StepOf(ConversationState state, Turn turn, string id, (string Name, JsonElement Input) tool,
        string kind, JsonElement block, JsonElement? structured)
    {
        var isError = StreamJson.True(block, "is_error");
        var counts = kind is "edit" or "write" && !isError ? FileChanges.Counts(structured) : null;
        yield return ConsoleEvents.Step(state.Key, id, kind, StreamJson.Target(tool.Name, tool.Input, turn.Directory),
            counts?.Added, counts?.Removed);
        foreach (var (text, error) in StreamJson.Outputs(tool.Name, block, structured))
        {
            yield return ConsoleEvents.StepOutput(state.Key, id, FileChanges.Cap(text), error);
        }
        if (tool.Name is "Edit" or "Write" or "NotebookEdit" && !isError
            && FileChanges.Relative(structured is { } result ? StreamJson.Str(result, "filePath") : null, paths.Root) is { } changed)
        {
            yield return ConsoleEvents.FilesChanged(state.Key, [changed]);
        }
        if (tool.Name == "Bash")
        {
            turn.RanCommand = true;
        }
    }

    // The end of the turn: idle, idle "interrupted" after an interrupt, or an error with the CLI's text.
    private async Task OnResultAsync(ConversationState state, Turn turn, JsonElement line)
    {
        var detail = StreamJson.Str(line, "result") is { Length: > 0 } text ? text : StreamJson.Str(line, "subtype") ?? "";
        var status = turn.Interrupting
            ? ConsoleEvents.Status(state.Key, "idle", Interrupted)
            : StreamJson.Str(line, "subtype") == "success" && !StreamJson.True(line, "is_error")
                ? ConsoleEvents.Status(state.Key, "idle")
                : ConsoleEvents.Status(state.Key, "error", "The prompt failed: " + (detail.Length <= 500 ? detail : detail[..500]));
        // A command can change files the CLI does not report: in a project that was a repository at the prompt, every
        // path whose git status changed since then.
        if (turn.RanCommand && turn.Before is { } before
            && FileChanges.Changed(before, FileChanges.Status(repositories, state.ProjectPath)) is { Count: > 0 } changed)
        {
            await EmitAsync(state, ConsoleEvents.FilesChanged(state.Key, changed));
        }
        await EndTurnAsync(state, status);
    }

    // Open questions end as denied, then the status; the conversation takes prompts again.
    private async Task EndTurnAsync(ConversationState state, JsonElement status)
    {
        if (state.Turn is { } turn)
        {
            await DenyPendingAsync(state, turn);
        }
        await EmitAsync(state, status);
        state.Turn = null;
        state.Busy = false;
        state.LastUsed = clock.GetUtcNow();
    }

    private async Task DenyPendingAsync(ConversationState state, Turn turn)
    {
        foreach (var requestId in turn.Pending.Keys.ToList())
        {
            turn.Pending.Remove(requestId);
            await EmitAsync(state, ConsoleEvents.Resolved(state.Key, requestId, "deny"));
        }
    }

    private async Task WatchInterruptAsync(ConversationState state, Turn turn, ClaudeProcess process)
    {
        await Task.Delay(InterruptTimeout);
        await state.Lock.WaitAsync();
        try
        {
            if (state.Turn != turn)
            {
                return;
            }
            await EndTurnAsync(state, ConsoleEvents.Status(state.Key, "idle", Interrupted));
            if (state.Process == process)
            {
                state.Process = null;
                state.Closing = process.KillAsync();
            }
        }
        catch (Exception e)
        {
            log.LogError(e, "Ending the interrupted turn of console conversation {Conversation} failed", state.Key);
        }
        finally
        {
            state.Lock.Release();
        }
    }

    private async Task SweepAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(IdleSweep, clock);
        try
        {
            while (await timer.WaitForNextTickAsync(ct))
            {
                try
                {
                    await CloseIdleAsync();
                }
                catch (Exception e)
                {
                    log.LogError(e, "Closing idle console processes failed");
                }
            }
        }
        catch (OperationCanceledException)
        {
            // The API stops.
        }
    }

    private async Task<ConversationState?> FindAsync(string? conversationId)
    {
        if (!Guid.TryParseExact(conversationId, "D", out var id))
        {
            return null;
        }
        if (_states.TryGetValue(id, out var state))
        {
            return state;
        }
        return await store.FindAsync(id) is { } row ? Track(row) : null;
    }

    private ConversationState Track(Conversation row) =>
        _states.GetOrAdd(row.Id, _ => new ConversationState(row.Id, row.ProjectPath, row.Resumable));

    // The real path of projectPath, which must be a directory in the projects directory (ProjectPaths); the process runs
    // there, and the conversation stays keyed by projectPath as sent.
    private string RealDirectory(string? projectPath) =>
        projectPath is not null && paths.Resolve(projectPath) is { Kind: PathKind.Directory } directory
            ? directory.FullPath
            : throw new HubException(InvalidPath);

    // Stores an event and sends it to every console connection; the caller holds the conversation's lock. Text deltas
    // are sent at once but stored as one row per messageId, written before the next other event.
    private async Task EmitAsync(ConversationState state, JsonElement e)
    {
        if (e.GetProperty("type").GetString() == "text")
        {
            var messageId = e.GetProperty("messageId").GetString()!;
            if (state.OpenText is not { } open || open.MessageId != messageId)
            {
                await FlushTextAsync(state);
                state.OpenText = (messageId, new StringBuilder());
            }
            state.OpenText.Value.Text.Append(e.GetProperty("delta").GetString());
        }
        else
        {
            await FlushTextAsync(state);
            await StoreAsync(state, e);
        }
        try
        {
            await hub.Clients.All.SendAsync("ConsoleEvent", e);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Sending an event of console conversation {Conversation} failed", state.Key);
        }
    }

    private async Task FlushTextAsync(ConversationState state)
    {
        if (state.OpenText is { } open)
        {
            state.OpenText = null;
            await StoreAsync(state, ConsoleEvents.Text(state.Key, open.MessageId, open.Text.ToString()));
        }
    }

    // A failed insert is logged and the event is still sent.
    private async Task StoreAsync(ConversationState state, JsonElement e)
    {
        try
        {
            state.NextSeq ??= await store.NextSeqAsync(state.Id);
            var seq = state.NextSeq.Value;
            state.NextSeq = seq + 1;
            await store.AppendAsync(state.Id, seq, e.GetRawText());
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Storing an event of console conversation {Conversation} failed; it was still sent", state.Key);
        }
    }

    private static JsonElement Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    // A stop: the open turn interrupted, then EOF on stdin.
    private static async Task EndAsync(ClaudeProcess process, bool interrupt)
    {
        if (interrupt)
        {
            try
            {
                await process.InterruptAsync();
            }
            catch (HubException)
            {
                // It is going anyway.
            }
        }
        process.CloseInput();
        await process.WaitForExitAsync(CloseWait);
    }

    private static async Task WithinAsync(Task task, TimeSpan limit)
    {
        try
        {
            await task.WaitAsync(limit);
        }
        catch (TimeoutException)
        {
            // What is left is killed.
        }
    }
}

// A conversation in memory. Every change of it and every event it sends happen under Lock.
internal sealed class ConversationState(Guid id, string projectPath, bool resumable)
{
    public Guid Id { get; } = id;
    public string Key { get; } = id.ToString("D");
    public string ProjectPath { get; } = projectPath;
    public SemaphoreSlim Lock { get; } = new(1, 1);
    // The CLI knows this id as a session: the next process starts with --resume.
    public bool Resumable { get; set; } = resumable;
    // null until it is read from the database.
    public int? NextSeq { get; set; }
    // The text deltas of one messageId so far, stored as one row before the next other event.
    public (string MessageId, StringBuilder Text)? OpenText { get; set; }
    // The real path of the project directory at the last launch.
    public string WorkingDirectory { get; set; } = "";
    public ClaudeProcess? Process { get; set; }
    // A launch holds a slot of the limit and has no process yet.
    public bool Launching { get; set; }
    // A process being closed (idle, the limit, an interrupt that timed out); the next launch waits for it.
    public Task Closing { get; set; } = Task.CompletedTask;
    // From an accepted prompt to the end of its turn.
    public bool Busy { get; set; }
    public Turn? Turn { get; set; }
    public DateTimeOffset LastUsed { get; set; }
    // Dropped from Conversations' memory by the idle check; a caller that still holds it looks the conversation up again.
    public bool Forgotten { get; set; }
}
