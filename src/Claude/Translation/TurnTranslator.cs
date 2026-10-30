// What one line of the claude CLI's stream-json output means for the conversation's turn (docs/ARCHITECTURE.md,
// "Backend" → "Console"): control requests and questions, their cancellation, init and refused tools, text deltas, tool
// steps with their output and changed files, and the result. Conversations calls it with the conversation's lock held.
// It never takes the lock, and it leaves the database, git and the CLI's stdin to Conversations through LineOutcome.
using System.Text.Json;
using Claushh.Api.Projects;

namespace Claushh.Api.Claude.Translation;

// What a line leaves to Conversations, which holds the lock. It marks the conversation resumable, answers an unsupported
// control request, or ends the turn after the git status check.
internal sealed record LineOutcome(bool MarkResumable = false, (string RequestId, string? Subtype)? Unsupported = null,
    JsonElement? TurnEnd = null, Dictionary<string, string>? StatusBefore = null)
{
    public static readonly LineOutcome None = new();
}

public sealed class TurnTranslator(ProjectPaths paths)
{
    // One line, under the conversation's lock and only while the process is the conversation's. Events leave through
    // emit, one by one and in order.
    internal async Task<LineOutcome> HandleAsync(ConversationState state, string? type, JsonElement line,
        Func<JsonElement, Task> emit)
    {
        if (type == "control_request")
        {
            return await OnControlRequestAsync(state, line, emit);
        }
        if (type == "control_cancel_request")
        {
            await OnCancelAsync(state, line, emit);
        }
        else if (type == "system")
        {
            return await OnSystemAsync(state, line, emit);
        }
        else if (state.Turn is { } turn)
        {
            switch (type)
            {
                case "stream_event":
                    await OnStreamEventAsync(state, turn, line, emit);
                    break;
                case "assistant":
                    OnAssistant(turn, line);
                    break;
                case "user":
                    await OnUserAsync(state, turn, line, emit);
                    break;
                case "result":
                    return OnResult(state, turn, line);
            }
        }
        return LineOutcome.None;
    }

    // Every control request of the CLI is answered, or the CLI waits for ever; one the console does not support gets an
    // error reply.
    private async Task<LineOutcome> OnControlRequestAsync(ConversationState state, JsonElement line,
        Func<JsonElement, Task> emit)
    {
        var requestId = StreamJson.Str(line, "request_id") ?? "";
        var request = StreamJson.Get(line, "request") ?? default;
        var subtype = StreamJson.Str(request, "subtype");
        if (subtype == "can_use_tool" && state.Turn is { } turn)
        {
            await AskAsync(state, turn, requestId, request, emit);
            return LineOutcome.None;
        }
        return new LineOutcome(Unsupported: (requestId, subtype));
    }

    // A question of the CLI: the server's own requestId, what it is for, and the one rule allow-always may save; then the
    // conversation waits. A question has no time limit.
    private async Task AskAsync(ConversationState state, Turn turn, string cliRequestId, JsonElement request,
        Func<JsonElement, Task> emit)
    {
        var tool = StreamJson.Str(request, "tool_name") ?? "";
        var input = StreamJson.Get(request, "input") ?? default;
        var (rule, alwaysRule) = PermissionRequests.Rule(request);
        var requestId = Guid.NewGuid().ToString("D");
        turn.Pending[requestId] = new PendingPermission(cliRequestId, tool, input, rule, alwaysRule);
        await emit(ConsoleEvents.Permission(state.Key, requestId, PermissionRequests.Description(tool, input, turn.Directory), alwaysRule));
        await emit(ConsoleEvents.Status(state.Key, "waiting"));
    }

    // The CLI no longer needs an answer (control_cancel_request): the question ends as denied.
    private async Task OnCancelAsync(ConversationState state, JsonElement line, Func<JsonElement, Task> emit)
    {
        if (state.Turn is not { } turn || StreamJson.Str(line, "request_id") is not { } cliRequestId)
        {
            return;
        }
        foreach (var requestId in turn.Pending.Where(entry => entry.Value.CliRequestId == cliRequestId).Select(entry => entry.Key).ToList())
        {
            turn.Pending.Remove(requestId);
            await emit(ConsoleEvents.Resolved(state.Key, requestId, "deny"));
            if (turn.Pending.Count == 0 && !turn.Interrupting)
            {
                await emit(ConsoleEvents.Status(state.Key, "working"));
            }
        }
    }

    // init: the CLI knows the conversation's id as its session, so the next process resumes it. permission_denied: a
    // tool the CLI refused on its own, without a question (--restricted, e.g. a file outside the directory), is a step of
    // kind other with the CLI's reason as its error output; its tool_result then adds nothing.
    private async Task<LineOutcome> OnSystemAsync(ConversationState state, JsonElement line, Func<JsonElement, Task> emit)
    {
        var subtype = StreamJson.Str(line, "subtype");
        if (subtype == "init" && !state.Resumable && StreamJson.Str(line, "session_id") == state.Key)
        {
            return new LineOutcome(MarkResumable: true);
        }
        if (subtype != "permission_denied" || state.Turn is not { } turn || StreamJson.Str(line, "tool_use_id") is not { } id
            || !turn.Tools.Remove(id, out var tool) || StreamJson.Kind(tool.Name, null) is null)
        {
            return LineOutcome.None;
        }
        await emit(ConsoleEvents.Step(state.Key, id, "other", StreamJson.Target(tool.Name, tool.Input, turn.Directory)));
        await emit(ConsoleEvents.StepOutput(state.Key, id,
            StreamJson.Str(line, "message") ?? StreamJson.Str(line, "decision_reason") ?? "", true));
        return LineOutcome.None;
    }

    // Text deltas of the conversation's own messages. A text block's messageId is "<message id>:<block index>", so text
    // after a tool in the same message starts a new entry. Thinking is not shown.
    private async Task OnStreamEventAsync(ConversationState state, Turn turn, JsonElement line, Func<JsonElement, Task> emit)
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
            await emit(ConsoleEvents.Text(state.Key, $"{turn.MessageId}:{index}", text));
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
    private async Task OnUserAsync(ConversationState state, Turn turn, JsonElement line, Func<JsonElement, Task> emit)
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
                await emit(e);
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
    private LineOutcome OnResult(ConversationState state, Turn turn, JsonElement line)
    {
        var detail = StreamJson.Str(line, "result") is { Length: > 0 } text ? text : StreamJson.Str(line, "subtype") ?? "";
        var status = turn.Interrupting
            ? ConsoleEvents.Status(state.Key, "idle", Conversations.Interrupted)
            : StreamJson.Str(line, "subtype") == "success" && !StreamJson.True(line, "is_error")
                ? ConsoleEvents.Status(state.Key, "idle")
                : ConsoleEvents.Status(state.Key, "error", "The prompt failed: " + (detail.Length <= 500 ? detail : detail[..500]));
        return new LineOutcome(TurnEnd: status, StatusBefore: turn.RanCommand ? turn.Before : null);
    }
}
