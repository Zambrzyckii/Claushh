// One tmux control-mode client (`tmux -C`, stdin and stdout as pipes) for one terminal (docs/ARCHITECTURE.md,
// "Backend" → "Terminal"): it reads tmux's lines as bytes, passes the pane's %output on, and matches each
// %begin … %end/%error block to the oldest command still waiting. The end of stdout is the end of the terminal.
using System.Buffers;
using System.Diagnostics;
using System.IO.Pipelines;
using System.Text;
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Terminal;

// A command's reply: its lines as tmux printed them, and the terminal's seq when its %begin was read.
public sealed record TmuxReply(bool Succeeded, IReadOnlyList<byte[]> Lines, long SeqAtBegin)
{
    public string Text(int line) => Encoding.UTF8.GetString(Lines[line]);
}

public sealed class TmuxControlClient : IAsyncDisposable
{
    private readonly Process _process;
    private readonly Func<string, ReadOnlyMemory<byte>, ValueTask> _output;
    private readonly Func<long> _seq;
    private readonly ILogger _log;
    // Commands waiting for their block, oldest first. One that ran out of time stays until its block arrives, so its
    // late reply is never taken for the next command's.
    private readonly Queue<TaskCompletionSource<TmuxReply>> _waiting = new();
    private readonly SemaphoreSlim _write = new(1, 1);
    private bool _ended;

    // output: the pane and the bytes of every %output line, awaited before the next line is read. seq: the terminal's
    // seq, read when a block begins.
    public TmuxControlClient(ProcessStartInfo start, Func<string, ReadOnlyMemory<byte>, ValueTask> output, Func<long> seq, ILogger log)
    {
        _output = output;
        _seq = seq;
        _log = log;
        start.RedirectStandardInput = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.StandardInputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        // The command on tmux's command line (new-session) gets the first block.
        var startup = NewReply();
        _waiting.Enqueue(startup);
        Started = startup.Task;
        _process = Process.Start(start) ?? throw new InvalidOperationException("tmux did not start.");
        Ended = Task.Run(ReadAsync);
        _ = Task.Run(DrainErrorsAsync);
    }

    public Task<TmuxReply> Started { get; }

    // Completes when tmux's output has ended and every waiting command has failed.
    public Task Ended { get; }

    // Sends `commands` tmux commands, as one line joined by " ; " or as lines joined by "\n", and returns a reply per
    // command: tmux answers each command of a line with a block of its own. onWritten, if given, runs once the write
    // has succeeded (tmux has read the line) but before the replies are awaited, so a caller can record state that
    // must survive a reply that arrives late or never; it never runs for a failed or cut-off write.
    public async Task<TmuxReply[]> RunAsync(string text, int commands = 1, Action? onWritten = null)
    {
        var replies = new TaskCompletionSource<TmuxReply>[commands];
        if (!await _write.WaitAsync(TmuxServer.CommandTimeout))
        {
            throw new HubException(TmuxServer.Unresponsive);
        }
        try
        {
            // Queued under the write lock, so the queue has the order in which tmux reads the commands.
            lock (_waiting)
            {
                if (_ended)
                {
                    throw new HubException(TmuxServer.Unresponsive);
                }
                for (var i = 0; i < commands; i++)
                {
                    _waiting.Enqueue(replies[i] = NewReply());
                }
            }
            try
            {
                await _process.StandardInput.WriteAsync(text + "\n").WaitAsync(TmuxServer.CommandTimeout);
                await _process.StandardInput.FlushAsync().WaitAsync(TmuxServer.CommandTimeout);
            }
            catch (TimeoutException)
            {
                // Cut off mid-line: tmux would read a corrupt command, so the control channel is no longer usable.
                // Killing the process ends the reader, which fails every waiting command (including this one).
                lock (_waiting)
                {
                    _ended = true;
                }
                try
                {
                    _process.Kill();
                }
                catch (InvalidOperationException)
                {
                    // It exited in the meantime.
                }
                throw new HubException(TmuxServer.Unresponsive);
            }
            onWritten?.Invoke();
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException)
        {
            // tmux has gone; the reader fails what waits.
            throw new HubException(TmuxServer.Unresponsive);
        }
        finally
        {
            _write.Release();
        }
        try
        {
            return await Task.WhenAll(replies.Select(reply => reply.Task)).WaitAsync(TmuxServer.CommandTimeout);
        }
        catch (TimeoutException)
        {
            throw new HubException(TmuxServer.Unresponsive);
        }
    }

    // EOF on stdin detaches the client; one still there after 2 s is killed.
    public async ValueTask DisposeAsync()
    {
        try
        {
            _process.StandardInput.Close();
        }
        catch (Exception e) when (e is IOException or InvalidOperationException)
        {
        }
        using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        try
        {
            await _process.WaitForExitAsync(wait.Token);
        }
        catch (OperationCanceledException)
        {
            try
            {
                _process.Kill();
            }
            catch (InvalidOperationException)
            {
                // It exited in the meantime.
            }
        }
        await Ended;
        _process.Dispose();
    }

    // Continuations run on the thread pool, never on the reader: a command sending the next one from its continuation
    // would otherwise wait for a reply only the reader can read.
    private static TaskCompletionSource<TmuxReply> NewReply() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    private async Task ReadAsync()
    {
        var reader = PipeReader.Create(_process.StandardOutput.BaseStream);
        Block? block = null;
        try
        {
            while (true)
            {
                var result = await reader.ReadAsync();
                var buffer = result.Buffer;
                while (buffer.PositionOf((byte)'\n') is { } end)
                {
                    var line = buffer.Slice(0, end).ToArray();
                    buffer = buffer.Slice(buffer.GetPosition(1, end));
                    block = await HandleAsync(line, block);
                }
                reader.AdvanceTo(buffer.Start, buffer.End);
                if (result.IsCompleted)
                {
                    break;
                }
            }
        }
        catch (Exception e)
        {
            _log.LogWarning(e, "Reading tmux's control output failed");
        }
        finally
        {
            await reader.CompleteAsync();
            TaskCompletionSource<TmuxReply>[] waiting;
            lock (_waiting)
            {
                _ended = true;
                waiting = [.. _waiting];
                _waiting.Clear();
            }
            foreach (var reply in waiting)
            {
                reply.TrySetException(new HubException(TmuxServer.Unresponsive));
            }
        }
    }

    // Inside a block every line belongs to the reply, also one that starts with "%": capture-pane prints pane text.
    private async ValueTask<Block?> HandleAsync(byte[] line, Block? block)
    {
        if (block is not null)
        {
            if (block.EndsWith(line) is { } succeeded)
            {
                Complete(new TmuxReply(succeeded, block.Lines, block.SeqAtBegin));
                return null;
            }
            block.Lines.Add(line);
            return block;
        }
        if (line.AsSpan().StartsWith("%begin "u8))
        {
            return new Block(Guard(line), _seq());
        }
        if (line.AsSpan().StartsWith("%output "u8) && Output(line) is { } output)
        {
            await _output(output.Pane, output.Data);
        }
        // Other notifications (%exit, %window-…, %session-…) are not needed: the end of stdout ends the terminal.
        return null;
    }

    private void Complete(TmuxReply reply)
    {
        TaskCompletionSource<TmuxReply>? waiting;
        lock (_waiting)
        {
            _waiting.TryDequeue(out waiting);
        }
        if (waiting is null)
        {
            _log.LogWarning("tmux sent a reply that no command was waiting for");
            return;
        }
        waiting.TrySetResult(reply);
    }

    private async Task DrainErrorsAsync()
    {
        try
        {
            while (await _process.StandardError.ReadLineAsync() is { } line)
            {
                _log.LogWarning("tmux: {Message}", line);
            }
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException or InvalidOperationException)
        {
        }
    }

    // "%begin 1363006971 2 1": the time and the command number, which the closing %end or %error repeats.
    private static string Guard(byte[] line)
    {
        var fields = Encoding.ASCII.GetString(line).Split(' ');
        return fields.Length >= 3 ? $"{fields[1]} {fields[2]}" : "";
    }

    // "%output %3 text": the pane, and the text with tmux's escapes undone (bytes below 0x20 and "\" come as \ooo).
    private static (string Pane, byte[] Data)? Output(byte[] line)
    {
        var start = "%output ".Length;
        var space = Array.IndexOf(line, (byte)' ', start);
        if (space < 0)
        {
            return null;
        }
        var data = new byte[line.Length - space - 1];
        var length = 0;
        for (var i = space + 1; i < line.Length; i++)
        {
            if (line[i] == '\\' && i + 3 < line.Length && IsOctal(line[i + 1]) && IsOctal(line[i + 2]) && IsOctal(line[i + 3]))
            {
                data[length++] = (byte)((line[i + 1] - '0') << 6 | (line[i + 2] - '0') << 3 | (line[i + 3] - '0'));
                i += 3;
            }
            else
            {
                data[length++] = line[i];
            }
        }
        return (Encoding.ASCII.GetString(line, start, space - start), data[..length]);
    }

    private static bool IsOctal(byte value) => value is >= (byte)'0' and <= (byte)'7';

    private sealed class Block(string guard, long seqAtBegin)
    {
        public List<byte[]> Lines { get; } = [];
        public long SeqAtBegin => seqAtBegin;

        // null while the block goes on; true for its %end, false for its %error.
        public bool? EndsWith(byte[] line)
        {
            var ok = line.AsSpan().StartsWith("%end "u8);
            return (ok || line.AsSpan().StartsWith("%error "u8)) && Guard(line) == guard ? ok : null;
        }
    }
}
