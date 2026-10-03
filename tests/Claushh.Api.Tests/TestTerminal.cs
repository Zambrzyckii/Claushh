// One browser tab on /hubs/terminal in the tests (docs/ARCHITECTURE.md, "Tests"): records every TerminalOutput and
// TerminalExited event in arrival order and waits for a terminal's output. Input batches carry this tab's client id and
// the next seq, as TerminalInputQueue does (web/src/app/features/terminal/terminal-input.ts).
using Microsoft.AspNetCore.SignalR.Client;

namespace Claushh.Api.Tests;

public sealed class TestTerminal : IAsyncDisposable
{
    public sealed record Info(string Id, string Title, string Cwd, bool Exited);
    public sealed record Output(string Id, long Seq, string Data);
    public sealed record Exit(string Id, int? ExitCode);
    public sealed record Attachment(string Snapshot, long Seq, long InputSeq);

    private readonly List<object> _events = [];
    private long _inputSeq;

    private TestTerminal(HubConnection hub) => Hub = hub;

    public HubConnection Hub { get; }

    // A random view id, as the frontend makes one per terminal and page load.
    public string Client { get; } = Guid.NewGuid().ToString();

    public static async Task<TestTerminal> ConnectAsync(ApiFactory api, ApiClient client)
    {
        var tab = new TestTerminal(TestHub.Build(api, client));
        tab.Hub.On<Output>("TerminalOutput", tab.Add);
        tab.Hub.On<Exit>("TerminalExited", tab.Add);
        await tab.Hub.StartAsync();
        return tab;
    }

    public Task<Info[]> ListAsync() => Hub.InvokeAsync<Info[]>("ListTerminals");

    public Task<Info> OpenAsync(string projectPath = "", int cols = 80, int rows = 24) =>
        Hub.InvokeAsync<Info>("OpenTerminal", new { projectPath, cols, rows });

    public Task CloseAsync(string id) => Hub.InvokeAsync("CloseTerminal", new { id });

    public Task<Attachment> AttachAsync(string id, int cols = 80, int rows = 24, string? client = null) =>
        Hub.InvokeAsync<Attachment>("Attach", new { id, cols, rows, client = client ?? Client });

    // One Input batch, with the next seq of this tab's client unless `seq` is given.
    public Task InputAsync(string id, string data, long? seq = null, string? client = null) =>
        Hub.InvokeAsync("Input", new { id, client = client ?? Client, seq = seq ?? Interlocked.Increment(ref _inputSeq), data });

    // A line and Enter in one batch.
    public Task TypeAsync(string id, string line) => InputAsync(id, line + "\r");

    public IReadOnlyList<Output> Outputs(string id)
    {
        lock (_events)
        {
            return [.. _events.OfType<Output>().Where(output => output.Id == id)];
        }
    }

    public string Text(string id) => string.Concat(Outputs(id).Select(output => output.Data));

    // The terminal's Output and Exit events in arrival order.
    public IReadOnlyList<object> Events(string id)
    {
        lock (_events)
        {
            return [.. _events.Where(e => e is Output output && output.Id == id || e is Exit exit && exit.Id == id)];
        }
    }

    // Waits until the terminal's output so far contains `text`; returns that output.
    public async Task<string> WaitForAsync(string id, string text, int seconds = 15)
    {
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (!Text(id).Contains(text, StringComparison.Ordinal))
        {
            Assert.True(DateTime.UtcNow < deadline, $"No \"{text}\" in the output of {id} within {seconds} s:\n{Text(id)}");
            await Task.Delay(20);
        }
        return Text(id);
    }

    public async Task<Exit> WaitForExitAsync(string id, int seconds = 15)
    {
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (true)
        {
            if (Events(id).OfType<Exit>().FirstOrDefault() is { } exit)
            {
                return exit;
            }
            Assert.True(DateTime.UtcNow < deadline, $"No TerminalExited for {id} within {seconds} s.");
            await Task.Delay(20);
        }
    }

    public ValueTask DisposeAsync() => Hub.DisposeAsync();

    private void Add(object e)
    {
        lock (_events)
        {
            _events.Add(e);
        }
    }
}
