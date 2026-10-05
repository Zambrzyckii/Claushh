// The git CLI, used only for the network (clone, fetch, pull, push) and the local steps around it (docs/ARCHITECTURE.md,
// "Backend" → "Workspaces and git"; decisions: docs/PLAN.md, "Backend decisions (stage 4)"): no shell, no prompts, only
// https, and a time limit after which the whole process tree gets SIGTERM, then a kill 1 s later.
using System.Diagnostics;
using System.Globalization;
using System.Text;
using Claushh.Api.Files;
using Claushh.Api.Processes;
using Microsoft.Extensions.Options;

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
    // The deadline alone, without the caller going away: a local step (e.g. `git merge --ff-only`) is linked to this
    // instead of `Token`, so it keeps running under its own cap when the client disconnects.
    public CancellationToken TimeoutToken => _timeout.Token;
    public bool Expired => _timeout.IsCancellationRequested;

    public void Dispose()
    {
        _any.Dispose();
        _timeout.Dispose();
    }
}

public sealed class GitRunner(ILogger<GitRunner> log, IOptionsMonitor<GitOptions> options)
{
    public static readonly TimeSpan LocalStepLimit = TimeSpan.FromSeconds(30);
    // How long git and its helpers have after SIGTERM before the tree is killed.
    private static readonly TimeSpan TerminateWait = TimeSpan.FromSeconds(1);

    private const int TailBytes = 64 * 1024;
    private const int MaxMessage = 4000;
    private static readonly string[] SafetyOptions = ["-c", "core.fsmonitor=false"];
    // Passed through from the API's own environment when set: git's config lookup and credential helpers such as
    // libsecret need them.
    private static readonly string[] Passthrough = ["XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

    // `git <arguments>` in `directory`, stopped when the deadline passes or, for a local step, after `stepLimit`. Throws
    // GitTimeoutException at a time limit and OperationCanceledException when the deadline was aborted. A local step
    // (`stepLimit` given) is not stopped when the caller goes away: only a network step is.
    public async Task<GitResult> RunAsync(string directory, IReadOnlyList<string> arguments, GitDeadline deadline, TimeSpan? stepLimit = null)
    {
        using var step = CancellationTokenSource.CreateLinkedTokenSource(stepLimit is null ? deadline.Token : deadline.TimeoutToken);
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

    private ProcessStartInfo StartInfo(string directory, IReadOnlyList<string> arguments)
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
        // A clean environment (ChildEnvironment), then: https as the only transport (GIT_ALLOW_PROTOCOL; git then reads no
        // protocol rule from its configuration files), the variables git's config lookup and credential helpers need,
        // then Git:Environment:* (configuration, which may replace GIT_ALLOW_PROTOCOL), then git's own variables, which
        // always win.
        var overrides = new Dictionary<string, string> { ["GIT_ALLOW_PROTOCOL"] = "https" };
        foreach (var name in Passthrough)
        {
            if (Environment.GetEnvironmentVariable(name) is { } value)
            {
                overrides[name] = value;
            }
        }
        foreach (var (name, value) in options.CurrentValue.Environment)
        {
            overrides[name] = value;
        }
        overrides["GIT_TERMINAL_PROMPT"] = "0";
        overrides["GCM_INTERACTIVE"] = "never";
        // English and stable messages, whatever the server's locale.
        overrides["LC_ALL"] = "C.UTF-8";
        ChildEnvironment.Apply(start, overrides);
        return start;
    }

    // git starts helpers (git-remote-https, the transport, hooks) as its children: all of them go. SIGTERM first, which
    // lets git remove its lock files; whatever still runs 1 s later is killed with the whole tree.
    private static void KillTree(Process git)
    {
        if (git.HasExited)
        {
            return;
        }
        foreach (var pid in Descendants(git.Id).Prepend(git.Id))
        {
            Libc.Terminate(pid);
        }
        if (!git.WaitForExit(TerminateWait))
        {
            try
            {
                git.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // It exited in the meantime.
            }
        }
        git.WaitForExit(TimeSpan.FromSeconds(5));
    }

    // The processes below `root`, from /proc/<pid>/task/<tid>/children (Linux); empty where the kernel has no such file.
    private static List<int> Descendants(int root)
    {
        var found = new List<int>();
        var parents = new Queue<int>([root]);
        while (parents.TryDequeue(out var parent))
        {
            string[] tasks;
            try
            {
                tasks = Directory.GetDirectories($"/proc/{parent}/task");
            }
            catch (IOException)
            {
                // It has exited.
                continue;
            }
            foreach (var task in tasks)
            {
                string children;
                try
                {
                    children = File.ReadAllText(Path.Join(task, "children"));
                }
                catch (IOException)
                {
                    continue;
                }
                foreach (var child in children.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                {
                    var pid = int.Parse(child, CultureInfo.InvariantCulture);
                    found.Add(pid);
                    parents.Enqueue(pid);
                }
            }
        }
        return found;
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
