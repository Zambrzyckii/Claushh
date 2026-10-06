// One browser tab on /hubs/console in the tests (docs/ARCHITECTURE.md, "Tests"): records every ConsoleEvent in arrival
// order and shows each as one short line ("step read notes.txt", "status idle interrupted"), so a test reads the stream
// as the panel does. Every call and wait has a deadline, so a server that hangs fails the test instead of the run.
using System.Text.Json;
using Microsoft.AspNetCore.SignalR.Client;

namespace Claushh.Api.Tests;

public sealed class TestConsole : IAsyncDisposable
{
    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(20);
    private readonly List<JsonElement> _events = [];

    private TestConsole(HubConnection hub) => Hub = hub;

    public HubConnection Hub { get; }

    public sealed record Snapshot(string? ConversationId, JsonElement[] Events);

    public static async Task<TestConsole> ConnectAsync(ApiFactory api, ApiClient client)
    {
        var tab = new TestConsole(TestHub.Build(api, client, "/hubs/console"));
        tab.Hub.On<JsonElement>("ConsoleEvent", tab.Add);
        await tab.Hub.StartAsync().WaitAsync(Deadline);
        return tab;
    }

    public Task<Snapshot> GetAsync(string? projectPath) =>
        Hub.InvokeAsync<Snapshot>("GetConversation", projectPath).WaitAsync(Deadline);

    public Task<string> StartAsync(string? projectPath) =>
        Hub.InvokeAsync<string>("StartConversation", projectPath).WaitAsync(Deadline);

    // A conversation in a new directory of the projects directory, with its script for the fake.
    public async Task<string> StartScriptedAsync(ApiFactory api, string projectPath, params string[] script)
    {
        Directory.CreateDirectory(api.ProjectPath(projectPath));
        var id = await StartAsync(projectPath);
        api.Claude.Script(id, script);
        return id;
    }

    public Task SendAsync(string conversationId, string text, string model = "haiku", string effort = "low", string mode = "default") =>
        Hub.InvokeAsync("SendPrompt", new { conversationId, text, model, effort, mode }).WaitAsync(Deadline);

    // A prompt that names an open file (ConsolePromptFileTests): `file` as the browser sends it.
    public Task SendWithFileAsync(string conversationId, string text, object? file) =>
        Hub.InvokeAsync("SendPrompt", new { conversationId, text, model = "haiku", effort = "low", mode = "default", file }).WaitAsync(Deadline);

    public Task AnswerAsync(string conversationId, string requestId, string decision) =>
        Hub.InvokeAsync("AnswerPermission", new { conversationId, requestId, decision }).WaitAsync(Deadline);

    public Task InterruptAsync(string conversationId) =>
        Hub.InvokeAsync("Interrupt", new { conversationId }).WaitAsync(Deadline);

    // The events of one conversation, or of all with null, in arrival order.
    public IReadOnlyList<JsonElement> Events(string? conversationId = null)
    {
        lock (_events)
        {
            return [.. _events.Where(e => conversationId is null || Str(e, "conversationId") == conversationId)];
        }
    }

    public IReadOnlyList<string> Shown(string conversationId) => [.. Events(conversationId).Select(Show)];

    // Waits until the conversation has an event that Show turns into `line`; returns it.
    public async Task<JsonElement> WaitForAsync(string conversationId, string line)
    {
        var deadline = DateTime.UtcNow + Deadline;
        while (true)
        {
            if (Events(conversationId).FirstOrDefault(e => Show(e) == line) is { ValueKind: not JsonValueKind.Undefined } found)
            {
                return found;
            }
            Assert.True(DateTime.UtcNow < deadline, $"No \"{line}\" within 20 s; the conversation showed:\n{string.Join("\n", Shown(conversationId))}");
            await Task.Delay(20);
        }
    }

    public static async Task UntilAsync(Func<bool> condition, string what) => await UntilAsync(() => Task.FromResult(condition()), what);

    public static async Task UntilAsync(Func<Task<bool>> condition, string what)
    {
        var deadline = DateTime.UtcNow + Deadline;
        while (!await condition())
        {
            Assert.True(DateTime.UtcNow < deadline, $"Not within 20 s: {what}");
            await Task.Delay(20);
        }
    }

    public static string Show(JsonElement e) => Str(e, "type") switch
    {
        "conversation" => $"conversation {Str(e, "projectPath")}",
        "prompt" => $"prompt {Str(e, "text")}",
        "step" => $"step {Str(e, "kind")} {Str(e, "target")}"
            + (e.TryGetProperty("added", out var added) ? $" +{added.GetInt32()} -{e.GetProperty("removed").GetInt32()}" : ""),
        "step-output" => $"{(e.GetProperty("isError").GetBoolean() ? "error" : "output")} {Str(e, "text")}",
        "text" => $"text {Str(e, "messageId")} {Str(e, "delta")}",
        "permission" => $"permission {Str(e, "description")}" + (Str(e, "alwaysRule") is { } rule ? $" [{rule}]" : ""),
        "permission-resolved" => $"resolved {Str(e, "decision")}",
        "status" => $"status {Str(e, "state")}" + (Str(e, "message") is { } message ? $" {message}" : ""),
        "files-changed" => $"files {string.Join(",", e.GetProperty("paths").EnumerateArray().Select(path => path.GetString()))}",
        var type => type ?? "?",
    };

    public static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    public ValueTask DisposeAsync() => Hub.DisposeAsync();

    private void Add(JsonElement e)
    {
        lock (_events)
        {
            _events.Add(e);
        }
    }
}
