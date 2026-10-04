// The console's conversations (docs/ARCHITECTURE.md, "Backend" → "Console"; decisions: docs/PLAN.md, "Backend
// decisions (stage 3)"). A singleton, because a hub instance lives for one call. Every event of a conversation is
// stored and then sent to every console connection under the conversation's lock, so all connections and a later
// replay see one order. Also the hosted service that prepares the claude CLI's config directory at start (never for
// create-user, which exits before the host runs).
using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using Claushh.Api.Files;
using Claushh.Api.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Claude;

// GetConversation's result: the project's latest conversation as its events (none: null and no events).
public sealed record ConversationSnapshot(string? ConversationId, IReadOnlyList<JsonElement> Events);

public sealed class Conversations(ClaudeCli cli, ConversationLog store, ProjectPaths paths, IHubContext<ConsoleHub> hub,
    ILogger<Conversations> log) : IHostedService
{
    public const string InvalidPath = "Nieprawidłowa ścieżka";

    private readonly ConcurrentDictionary<Guid, ConversationState> _states = new();

    public Task StartAsync(CancellationToken cancellationToken)
    {
        cli.PrepareDirectory();
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    // For the tests, before every test: every conversation in memory is forgotten (the test deletes the rows next).
    public Task CloseAllAsync()
    {
        _states.Clear();
        return Task.CompletedTask;
    }

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

    private ConversationState Track(Conversation row) =>
        _states.GetOrAdd(row.Id, _ => new ConversationState(row.Id, row.ProjectPath, row.Resumable));

    // The real path of projectPath, which must be a directory in the projects directory (ProjectPaths); a process runs
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
}

// A conversation in memory: its lock, the next event number and the text block being streamed. Every change of it and
// every event it sends happen under Lock.
internal sealed class ConversationState(Guid id, string projectPath, bool resumable)
{
    public Guid Id { get; } = id;
    public string Key { get; } = id.ToString("D");
    public string ProjectPath { get; } = projectPath;
    public SemaphoreSlim Lock { get; } = new(1, 1);
    public bool Resumable { get; set; } = resumable;
    // null until it is read from the database.
    public int? NextSeq { get; set; }
    // The text deltas of one messageId so far, stored as one row before the next other event.
    public (string MessageId, StringBuilder Text)? OpenText { get; set; }
}
