// One terminal (docs/ARCHITECTURE.md, "Backend" → "Terminal"; decisions: docs/PLAN.md, "Backend decisions (stage 4)"):
// the tmux session claushh-<id> and the control client attached to it for the terminal's whole life. Output gets its
// seq here; starting and the commands of the views run one at a time under the terminal's lock.
using System.Text;
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Terminal;

public sealed record TerminalInfo(string Id, string Title, string Cwd, bool Exited);
public sealed record TerminalOutput(string Id, long Seq, string Data);
public sealed record TerminalExit(string Id, int? ExitCode);

public sealed class TerminalSession(string id, string title, string cwd, TmuxServer tmux,
    Func<TerminalOutput, Task> output, Func<TerminalSession, Task> exited, ILogger log)
{
    private readonly SemaphoreSlim _lock = new(1, 1);
    // One decoder for the whole output: a character can be split between two %output lines; invalid bytes become U+FFFD.
    private readonly Decoder _decoder = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: false).GetDecoder();
    private TmuxControlClient? _client;
    private volatile string _pane = "";
    private long _seq;
    private volatile bool _exited;

    public string Id => id;
    public string Title => title;
    public TerminalInfo Info => new(id, title, cwd, _exited);
    private string SessionName => $"claushh-{id}";

    public static int Cols(int cols) => Math.Clamp(cols, 10, 1000);
    public static int Rows(int rows) => Math.Clamp(rows, 2, 500);

    // `directory` is the real path; "#" is doubled because tmux expands formats in -c.
    public async Task StartAsync(string directory, int cols, int rows)
    {
        await _lock.WaitAsync();
        try
        {
            var start = tmux.StartInfo(["-C", "new-session", "-s", SessionName, "-c", directory.Replace("#", "##"),
                "-x", $"{cols}", "-y", $"{rows}"]);
            _client = new TmuxControlClient(start, OnOutputAsync, () => Interlocked.Read(ref _seq), log);
            _ = WatchAsync(_client);
            TmuxReply started;
            try
            {
                started = await _client.Started.WaitAsync(TmuxServer.CommandTimeout);
            }
            catch (TimeoutException)
            {
                throw new HubException(TmuxServer.Unresponsive);
            }
            if (!started.Succeeded)
            {
                throw new HubException(TmuxServer.Unavailable);
            }
            var pane = await RunAsync("display-message -p '#{pane_id}'");
            _pane = pane.Lines.Count == 1 && pane.Text(0).StartsWith('%')
                ? pane.Text(0)
                : throw new HubException(TmuxServer.Unresponsive);
            await RunAsync($"refresh-client -C {cols}x{rows}");
        }
        finally
        {
            _lock.Release();
        }
    }

    // Called after the terminal left the list, so its end sends no TerminalExited.
    public async Task CloseAsync()
    {
        try
        {
            await tmux.RunAsync(["kill-session", "-t", $"={SessionName}"], CancellationToken.None);
        }
        catch (Exception e) when (e is HubException or IOException or System.ComponentModel.Win32Exception)
        {
            log.LogWarning(e, "Ending tmux session {Session} failed", SessionName);
        }
        if (_client is not null)
        {
            await _client.DisposeAsync();
        }
    }

    private async Task<TmuxReply> RunAsync(string command)
    {
        var reply = (await _client!.RunAsync(command))[0];
        if (!reply.Succeeded)
        {
            log.LogWarning("tmux refused {Command}: {Error}", command.Split(' ')[0], reply.Lines.Count > 0 ? reply.Text(0) : "");
            throw new HubException(TmuxServer.Unresponsive);
        }
        return reply;
    }

    // On the control client's reader, one fragment at a time. The reader waits for the send, so every connection gets the
    // order, and a slow browser slows the reader instead of filling memory.
    private async ValueTask OnOutputAsync(string pane, ReadOnlyMemory<byte> bytes)
    {
        // Another pane: a window opened with tmux from inside the shell.
        if (_pane.Length > 0 && pane != _pane)
        {
            return;
        }
        var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
        var count = _decoder.GetChars(bytes.Span, chars, flush: false);
        if (count == 0)
        {
            return;
        }
        try
        {
            await output(new TerminalOutput(id, Interlocked.Increment(ref _seq), new string(chars, 0, count)));
        }
        catch (Exception e)
        {
            log.LogWarning(e, "Sending the output of terminal {Id} failed", id);
        }
    }

    // The end of tmux's output is the end of the terminal: the shell exited and the session closed, or tmux went away.
    private async Task WatchAsync(TmuxControlClient client)
    {
        await client.Ended;
        _exited = true;
        try
        {
            await exited(this);
        }
        catch (Exception e)
        {
            log.LogWarning(e, "Reporting the end of terminal {Id} failed", id);
        }
    }
}
