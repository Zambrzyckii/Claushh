// One claude process of a conversation (docs/ARCHITECTURE.md, "Backend" → "Console"): stdout read as JSON lines of at
// most 16 MB, stdin written one line at a time under a lock within 10 s, the API's own control requests matched to
// their replies, and the whole process tree killed when it has to go.
using System.Buffers;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipelines;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Claude;

internal sealed class ClaudeProcess
{
    public const string Unresponsive = "Console not responding";
    public const int MaxLine = 16 * 1024 * 1024;
    public static readonly TimeSpan ReplyTimeout = TimeSpan.FromSeconds(10);
    public static readonly TimeSpan InitializeTimeout = TimeSpan.FromSeconds(30);

    private readonly Process _process;
    private readonly PipeReader _stdout;
    private readonly ILogger _log;
    private readonly SemaphoreSlim _write = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _replies = new(StringComparer.Ordinal);
    private volatile bool _ended;

    private ClaudeProcess(Process process, ILogger log)
    {
        _process = process;
        _log = log;
        _stdout = PipeReader.Create(process.StandardOutput.BaseStream);
        _ = Task.Run(DrainErrorsAsync);
    }

    public static ClaudeProcess Start(ProcessStartInfo start, ILogger log) =>
        new(Process.Start(start) ?? throw new InvalidOperationException("claude did not start."), log);

    // The CLI's first answer, within 30 s.
    public Task InitializeAsync() => RequestAsync(new { subtype = "initialize" }, InitializeTimeout);

    // The prompt's options, each awaited: the mode may have changed inside the CLI (an approved plan).
    public async Task ApplyAsync(PromptOptions options)
    {
        await RequestAsync(new { subtype = "set_model", model = options.Model }, ReplyTimeout);
        await RequestAsync(new { subtype = "set_permission_mode", mode = options.Mode }, ReplyTimeout);
        await RequestAsync(new { subtype = "apply_flag_settings", settings = new { effortLevel = options.Effort } }, ReplyTimeout);
    }

    // The user line of a prompt, attributed to a person, with the note of its open file as a second text block. A prompt
    // starting with "/" is marked client_composed, so the CLI gives it to the model as text instead of running it as one
    // of its own commands.
    public Task SendPromptAsync(string text, string? note)
    {
        var content = note is null
            ? new[] { new { type = "text", text } }
            : new[] { new { type = "text", text }, new { type = "text", text = note } };
        var message = new { role = "user", content };
        var uuid = Guid.NewGuid().ToString("D");
        var origin = new { kind = "human" };
        object line = text.TrimStart().StartsWith('/')
            ? new { type = "user", message, parent_tool_use_id = (string?)null, uuid, origin, client_composed = true }
            : new { type = "user", message, parent_tool_use_id = (string?)null, uuid, origin };
        return WriteAsync(line);
    }

    public Task InterruptAsync() => WriteAsync(new { type = "control_request", request_id = NewId(), request = new { subtype = "interrupt" } });

    public Task ReplyAsync(string requestId, object response) =>
        WriteAsync(new { type = "control_response", response = new { subtype = "success", request_id = requestId, response } });

    public Task ReplyErrorAsync(string requestId, string error) =>
        WriteAsync(new { type = "control_response", response = new { subtype = "error", request_id = requestId, error } });

    // The next stdout line, parsed; null at the end of the output. A line that is not JSON throws JsonException after
    // it is consumed (the caller skips it); a line over MaxLine bytes throws InvalidDataException.
    public async Task<JsonElement?> ReadLineAsync()
    {
        while (true)
        {
            var result = await _stdout.ReadAsync();
            var buffer = result.Buffer;
            var end = buffer.PositionOf((byte)'\n');
            if (end is null && !result.IsCompleted)
            {
                if (buffer.Length > MaxLine)
                {
                    throw new InvalidDataException("A line of claude's output is over 16 MB.");
                }
                _stdout.AdvanceTo(buffer.Start, buffer.End);
                continue;
            }
            var line = end is { } position ? buffer.Slice(0, position) : buffer;
            if (line.Length > MaxLine)
            {
                throw new InvalidDataException("A line of claude's output is over 16 MB.");
            }
            var bytes = line.ToArray();
            _stdout.AdvanceTo(end is { } next ? buffer.GetPosition(1, next) : buffer.End);
            if (bytes.Length > 0)
            {
                using var document = JsonDocument.Parse(bytes);
                return document.RootElement.Clone();
            }
            if (end is null)
            {
                return null;
            }
        }
    }

    // A control_response: the reply to one of the API's own requests; one nobody waits for (a late reply) is dropped.
    public void Complete(JsonElement line)
    {
        if (StreamJson.Get(line, "response") is { } response && StreamJson.Str(response, "request_id") is { } id
            && _replies.TryRemove(id, out var reply))
        {
            reply.TrySetResult(response);
        }
    }

    // EOF on stdin: the CLI ends after its current work.
    public void CloseInput()
    {
        try
        {
            _process.StandardInput.Close();
        }
        catch (Exception e) when (e is IOException or InvalidOperationException or ObjectDisposedException)
        {
            // Gone already.
        }
    }

    // stdin closed; still running after `wait`, killed with its children.
    public async Task CloseAsync(TimeSpan wait)
    {
        CloseInput();
        if (!await WaitForExitAsync(wait))
        {
            KillTree();
        }
    }

    public async Task KillAsync()
    {
        KillTree();
        await WaitForExitAsync(TimeSpan.FromSeconds(5));
    }

    // The CLI starts shells and their commands as its children: all of them go.
    public void KillTree()
    {
        try
        {
            _process.Kill(entireProcessTree: true);
        }
        catch (Exception e) when (e is InvalidOperationException or Win32Exception or NotSupportedException)
        {
            // It exited in the meantime.
        }
    }

    // false: still running after `wait`. A process already released after its exit (ExitAsync) counts as ended.
    public async Task<bool> WaitForExitAsync(TimeSpan wait)
    {
        using var limit = new CancellationTokenSource(wait);
        try
        {
            await _process.WaitForExitAsync(limit.Token);
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
        catch (InvalidOperationException)
        {
            return true;
        }
    }

    // After the end of stdout: replies still awaited fail, then the exit code (a process that keeps running without
    // stdout is killed after 5 s). Then stdout and the process are released; later calls find it gone.
    public async Task<int> ExitAsync()
    {
        _ended = true;
        foreach (var reply in _replies.Values)
        {
            reply.TrySetException(new HubException(Unresponsive));
        }
        if (!await WaitForExitAsync(TimeSpan.FromSeconds(5)))
        {
            KillTree();
            await _process.WaitForExitAsync();
        }
        var code = _process.ExitCode;
        await _stdout.CompleteAsync();
        _process.Dispose();
        return code;
    }

    // A control request of the API's own, awaited within `timeout`; one without its reply kills the process tree.
    private async Task RequestAsync(object request, TimeSpan timeout)
    {
        var id = NewId();
        var reply = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        _replies[id] = reply;
        try
        {
            if (_ended)
            {
                throw new HubException(Unresponsive);
            }
            await WriteAsync(new { type = "control_request", request_id = id, request });
            JsonElement response;
            try
            {
                response = await reply.Task.WaitAsync(timeout);
            }
            catch (TimeoutException)
            {
                KillTree();
                throw new HubException(Unresponsive);
            }
            if (StreamJson.Str(response, "subtype") != "success")
            {
                _log.LogWarning("claude refused a control request: {Error}", StreamJson.Str(response, "error"));
                throw new HubException(Unresponsive);
            }
        }
        finally
        {
            _replies.TryRemove(id, out _);
        }
    }

    // One line on stdin within 10 s; a write cut off by the limit kills the process tree, because the CLI would read
    // half a line.
    private async Task WriteAsync(object line)
    {
        byte[] bytes = [.. JsonSerializer.SerializeToUtf8Bytes(line), (byte)'\n'];
        if (!await _write.WaitAsync(ReplyTimeout))
        {
            throw new HubException(Unresponsive);
        }
        try
        {
            var stdin = _process.StandardInput.BaseStream;
            await stdin.WriteAsync(bytes).AsTask().WaitAsync(ReplyTimeout);
            await stdin.FlushAsync().WaitAsync(ReplyTimeout);
        }
        catch (TimeoutException)
        {
            KillTree();
            throw new HubException(Unresponsive);
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException or InvalidOperationException)
        {
            throw new HubException(Unresponsive);
        }
        finally
        {
            _write.Release();
        }
    }

    private async Task DrainErrorsAsync()
    {
        try
        {
            while (await _process.StandardError.ReadLineAsync() is { } line)
            {
                _log.LogWarning("claude: {Message}", line);
            }
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException or InvalidOperationException)
        {
        }
    }

    private static string NewId() => "claushh-" + Guid.NewGuid().ToString("N");
}
