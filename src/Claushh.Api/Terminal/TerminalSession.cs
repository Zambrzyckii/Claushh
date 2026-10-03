// One terminal (docs/ARCHITECTURE.md, "Backend" → "Terminal"; decisions: docs/PLAN.md, "Backend decisions (stage 4)"):
// the tmux session claushh-<id> and the control client attached to it for the terminal's whole life. Output gets its
// seq here; starting and the commands of the views run one at a time under the terminal's lock.
using System.Globalization;
using System.Text;
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Terminal;

public sealed record TerminalInfo(string Id, string Title, string Cwd, bool Exited);
public sealed record TerminalOutput(string Id, long Seq, string Data);
public sealed record TerminalExit(string Id, int? ExitCode);
public sealed record Attachment(string Snapshot, long Seq, long InputSeq);

public sealed class TerminalSession(string id, string title, string cwd, TmuxServer tmux,
    Func<TerminalOutput, Task> output, Func<TerminalSession, Task> exited, ILogger log)
{
    // Bytes per send-keys command.
    private const int InputChunk = 1024;

    private readonly SemaphoreSlim _lock = new(1, 1);
    // One decoder for the whole output: a character can be split between two %output lines; invalid bytes become U+FFFD.
    private readonly Decoder _decoder = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: false).GetDecoder();
    private TmuxControlClient? _client;
    private volatile string _pane = "";
    private long _seq;
    private volatile bool _exited;
    // Guarded by _lock: set once, by StartAsync (when it finds it already set) or by CloseAsync (which then runs),
    // so a close racing a start neither misses the session nor disposes the client twice.
    private bool _closed;
    // Per view (client): the connection of its last Attach and its last accepted batch, kept until the terminal is
    // closed (one entry per page load).
    private readonly Dictionary<string, string> _owners = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _inputSeq = new(StringComparer.Ordinal);

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
            if (_closed)
            {
                throw new HubException(TmuxServer.Unavailable);
            }
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

    // Treated like an exited terminal: Attach gives an empty snapshot, Input is skipped, Resize is ignored, never a
    // NullReferenceException. Read only under _lock, like _closed and _client.
    private bool Unavailable => _exited || _closed || _client is null;

    // client null: the view gets the snapshot, but no Input of it is accepted.
    public async Task<Attachment> AttachAsync(int cols, int rows, string? client, string connection)
    {
        await _lock.WaitAsync();
        try
        {
            if (client is not null)
            {
                _owners[client] = connection;
            }
            var inputSeq = client is null ? 0 : _inputSeq.GetValueOrDefault(client);
            if (!Unavailable)
            {
                try
                {
                    return await SnapshotAsync(cols, rows, inputSeq);
                }
                catch (HubException) when (_exited || _client?.Ended.IsCompleted == true)
                {
                    // The shell ended meanwhile (WatchAsync may not have set _exited yet).
                }
            }
            return new Attachment("", Interlocked.Read(ref _seq), inputSeq);
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task InputAsync(string client, long seq, string data, string connection)
    {
        await _lock.WaitAsync();
        try
        {
            if (Unavailable)
            {
                return;
            }
            if (!_owners.TryGetValue(client, out var owner) || owner != connection)
            {
                throw new HubException("Najpierw Attach na tym połączeniu");
            }
            if (seq <= _inputSeq.GetValueOrDefault(client))
            {
                return;
            }
            var bytes = Encoding.UTF8.GetBytes(data);
            if (bytes.Length == 0)
            {
                _inputSeq[client] = seq;
                return;
            }
            // Every byte as it is: keys, paste markers and control characters reach the program unchanged.
            var commands = bytes.Chunk(InputChunk)
                .Select(chunk => $"send-keys -t {_pane} -H " + string.Join(' ', chunk.Select(b => b.ToString("x2", CultureInfo.InvariantCulture))))
                .ToArray();
            // Recorded as soon as tmux has read the line, not after its reply: with heavy output the reply waits
            // behind the output read before it and can arrive past the 10 s deadline, and a batch the caller then
            // retries with the same seq must still be typed once, not twice.
            var written = false;
            try
            {
                var replies = await _client!.RunAsync(string.Join('\n', commands), commands.Length,
                    onWritten: () => { written = true; _inputSeq[client] = seq; });
                if (!Array.TrueForAll(replies, reply => reply.Succeeded))
                {
                    throw new HubException(TmuxServer.Unresponsive);
                }
            }
            catch (HubException) when (written)
            {
                // The write succeeded (seq already recorded) but the reply was late (past the 10 s deadline, behind
                // the output read before it) or lost, or tmux answered %error.
                log.LogWarning("The reply to a send-keys batch for terminal {Id} was late or lost", id);
                throw;
            }
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task ResizeAsync(int cols, int rows)
    {
        await _lock.WaitAsync();
        try
        {
            if (!Unavailable)
            {
                await RunAsync($"refresh-client -C {cols}x{rows}");
            }
        }
        catch (HubException e)
        {
            // A send: nobody waits for an answer.
            log.LogWarning("Resizing terminal {Id} failed: {Message}", id, e.Message);
        }
        finally
        {
            _lock.Release();
        }
    }

    // Under the lock, so no Input or Resize of this terminal runs in between.
    private async Task<Attachment> SnapshotAsync(int cols, int rows, long inputSeq)
    {
        await RunAsync($"refresh-client -C {cols}x{rows}");
        var replies = await RunLineAsync(TerminalSnapshot.NormalCommands(_pane), 2);
        var display = TerminalSnapshot.Display.Parse(replies[0]);
        if (!display.AlternateOn)
        {
            return new Attachment(TerminalSnapshot.Normal(display, replies[1].Lines), replies[1].SeqAtBegin, inputSeq);
        }
        replies = await RunLineAsync(TerminalSnapshot.AlternateCommands(_pane), 3);
        display = TerminalSnapshot.Display.Parse(replies[0]);
        var text = display.AlternateOn
            ? TerminalSnapshot.Alternate(display, replies[1].Lines, replies[2].Lines, log)
            : TerminalSnapshot.Normal(display, replies[1].Lines);
        return new Attachment(text, replies[1].SeqAtBegin, inputSeq);
    }

    // A line of commands that must come back as one piece: all answered, all at one seq.
    private async Task<TmuxReply[]> RunLineAsync(string line, int commands)
    {
        var replies = await _client!.RunAsync(line, commands);
        if (!Array.TrueForAll(replies, reply => reply.Succeeded))
        {
            throw new HubException(TmuxServer.Unresponsive);
        }
        if (replies[0].SeqAtBegin != replies[^1].SeqAtBegin)
        {
            log.LogWarning("Output arrived between the snapshot commands of terminal {Id}", id);
        }
        return replies;
    }

    // Called after the terminal left the list, so its end sends no TerminalExited. Idempotent, and safe while a start
    // is in progress: it waits for the same lock, so it never misses a session that is still being created.
    public async Task CloseAsync()
    {
        await _lock.WaitAsync();
        try
        {
            if (_closed)
            {
                return;
            }
            _closed = true;
        }
        finally
        {
            _lock.Release();
        }
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
        // Best effort: a client detached from inside the pane (`tmux detach`; TMUX points at the API's own socket)
        // ends the control client's output without ending the session, which would otherwise keep the shell running
        // unlisted.
        try
        {
            await tmux.RunAsync(["kill-session", "-t", $"={SessionName}"], CancellationToken.None);
        }
        catch (Exception e) when (e is HubException or IOException or System.ComponentModel.Win32Exception)
        {
            log.LogWarning(e, "Ending tmux session {Session} failed", SessionName);
        }
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
