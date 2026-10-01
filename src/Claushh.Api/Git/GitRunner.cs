// The git CLI, used only for the network (clone, fetch, pull, push) and the local steps around it (docs/ARCHITECTURE.md,
// "Backend" → "Workspaces and git"; decisions: docs/PLAN.md, "Backend decisions (stage 4)"): no shell, no prompts, only
// https, and a time limit after which the whole process tree is killed.
using System.Diagnostics;
using System.Text;

namespace Claushh.Api.Git;

// Output: stdout (its last 64 KB). Message: stderr then stdout, trimmed, at most 4000 characters, for the response.
public sealed record GitResult(int ExitCode, string Output, string Message)
{
    public bool Succeeded => ExitCode == 0;
}

// Git ran out of its time limit (the request's deadline or a local step's cap) and its process tree was killed.
public sealed class GitTimeoutException(TimeSpan limit) : Exception($"git did not finish within {(int)limit.TotalSeconds} s")
{
    public string ResponseMessage { get; } = $"Git nie skończył w ciągu {(int)limit.TotalSeconds} s i został przerwany.";
}

// The one time limit of a request (or a background fetch), counted from its start. Aborted: the client went away, the
// API is stopping, or a request took the lock from a background fetch; then there is no one to answer.
public sealed class GitDeadline : IDisposable
{
    private readonly CancellationTokenSource _timeout;
    private readonly CancellationTokenSource _any;

    public GitDeadline(TimeSpan limit, CancellationToken aborted)
    {
        Limit = limit;
        Aborted = aborted;
        _timeout = new CancellationTokenSource(limit);
        _any = CancellationTokenSource.CreateLinkedTokenSource(_timeout.Token, aborted);
    }

    public TimeSpan Limit { get; }
    public CancellationToken Aborted { get; }
    public CancellationToken Token => _any.Token;
    public bool Expired => _timeout.IsCancellationRequested;

    public void Dispose()
    {
        _any.Dispose();
        _timeout.Dispose();
    }
}

public sealed class GitRunner(ILogger<GitRunner> log)
{
    public static readonly TimeSpan LocalStepLimit = TimeSpan.FromSeconds(30);

    private const int TailBytes = 64 * 1024;
    private const int MaxMessage = 4000;
    private static readonly string[] SafetyOptions =
        ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "core.fsmonitor=false"];
    private static readonly string[] RemovedVariables = ["GIT_ASKPASS", "SSH_ASKPASS", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];

    // `git <arguments>` in `directory`, stopped when the deadline passes or, for a local step, after `stepLimit`. Throws
    // GitTimeoutException at a time limit and OperationCanceledException when the deadline was aborted.
    public async Task<GitResult> RunAsync(string directory, IReadOnlyList<string> arguments, GitDeadline deadline, TimeSpan? stepLimit = null)
    {
        using var step = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token);
        if (stepLimit is { } cap)
        {
            step.CancelAfter(cap);
        }
        var started = Stopwatch.GetTimestamp();
        using var git = Process.Start(StartInfo(directory, arguments))!;
        git.StandardInput.Close();
        var output = ReadTailAsync(git.StandardOutput.BaseStream);
        var error = ReadTailAsync(git.StandardError.BaseStream);
        try
        {
            await git.WaitForExitAsync(step.Token);
            await Task.WhenAll(output, error).WaitAsync(step.Token);
        }
        catch (OperationCanceledException)
        {
            KillTree(git);
            log.LogWarning("git {Operation} in {Directory} was stopped after {Milliseconds} ms",
                arguments[0], directory, (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds);
            if (deadline.Aborted.IsCancellationRequested)
            {
                throw;
            }
            throw new GitTimeoutException(deadline.Expired ? deadline.Limit : stepLimit ?? deadline.Limit);
        }
        log.LogInformation("git {Operation} in {Directory} exited with {ExitCode} after {Milliseconds} ms",
            arguments[0], directory, git.ExitCode, (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        var stdout = await output;
        return new GitResult(git.ExitCode, stdout, MessageOf(await error, stdout));
    }

    private static ProcessStartInfo StartInfo(string directory, IReadOnlyList<string> arguments)
    {
        var start = new ProcessStartInfo("git")
        {
            WorkingDirectory = directory,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in SafetyOptions.Concat(arguments))
        {
            start.ArgumentList.Add(argument);
        }
        start.Environment["GIT_TERMINAL_PROMPT"] = "0";
        start.Environment["GCM_INTERACTIVE"] = "never";
        // English and stable messages, whatever the server's locale.
        start.Environment["LC_ALL"] = "C.UTF-8";
        foreach (var name in RemovedVariables)
        {
            start.Environment.Remove(name);
        }
        return start;
    }

    // git starts helpers (git-remote-https, the transport) as its children: all of them go.
    private static void KillTree(Process git)
    {
        try
        {
            git.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // It exited in the meantime.
        }
        git.WaitForExit(TimeSpan.FromSeconds(5));
    }

    // The last TailBytes bytes of a stream, decoded as UTF-8.
    private static async Task<string> ReadTailAsync(Stream stream)
    {
        var tail = new byte[TailBytes];
        var length = 0;
        var chunk = new byte[8192];
        int read;
        while ((read = await stream.ReadAsync(chunk)) > 0)
        {
            var keep = Math.Min(length, TailBytes - read);
            tail.AsSpan(length - keep, keep).CopyTo(tail);
            chunk.AsSpan(0, read).CopyTo(tail.AsSpan(keep));
            length = keep + read;
        }
        return Encoding.UTF8.GetString(tail, 0, length);
    }

    private static string MessageOf(string stderr, string stdout)
    {
        var message = string.Join('\n', new[] { stderr.Trim(), stdout.Trim() }.Where(part => part.Length > 0));
        return message.Length <= MaxMessage ? message : message[..MaxMessage];
    }
}
