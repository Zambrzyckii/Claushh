// The fetch that keeps the Workspace panel's ↑/↓ fresh (docs/ARCHITECTURE.md, "Backend" → "Workspaces and git";
// decisions: docs/PLAN.md, "Backend decisions (stage 4)"): GET /api/repos starts it in the background for every
// repository with an upstream whose last attempt is at least 5 minutes old, and never waits for it.
using System.Collections.Concurrent;
using Microsoft.Extensions.Options;

namespace Claushh.Api.Git;

public sealed class BackgroundFetch(RepoLocks locks, GitRunner git, IOptionsMonitor<GitOptions> options, TimeProvider clock,
    IHostApplicationLifetime lifetime, ILogger<BackgroundFetch> log)
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(5);

    // The time of the last attempt, by repository directory.
    private readonly Dictionary<string, DateTimeOffset> _attempts = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<Task, CancellationTokenSource> _running = new();

    // `git fetch <remote>` in `directory`, unless it was tried less than 5 minutes ago or the repository is busy (then
    // the next list tries again). Returns at once. `relative` (the API path, never a resolved path) is only for logging.
    public void Start(string directory, string relative, string remote)
    {
        var now = clock.GetUtcNow();
        lock (_attempts)
        {
            if (_attempts.TryGetValue(directory, out var last) && now - last < Interval)
            {
                return;
            }
            // Cancelled by a request that needs the repository, and when the API stops.
            var stop = CancellationTokenSource.CreateLinkedTokenSource(lifetime.ApplicationStopping);
            if (locks.TryEnterForFetch(directory, stop) is not { } lease)
            {
                stop.Dispose();
                return;
            }
            _attempts[directory] = now;
            var fetch = Task.Run(() => FetchAsync(directory, relative, remote, lease, stop));
            _running[fetch] = stop;
            fetch.ContinueWith(done => _running.TryRemove(done, out _), TaskScheduler.Default);
        }
    }

    // For the tests (ApiFactory.ResetAsync): stops the running fetches, waits for them and forgets every attempt, so the
    // fetches of one test neither touch nor throttle the repositories of the next.
    public async Task ResetAsync()
    {
        foreach (var stop in _running.Values)
        {
            try
            {
                stop.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // That fetch has just finished.
            }
        }
        await Task.WhenAll(_running.Keys);
        lock (_attempts)
        {
            _attempts.Clear();
        }
    }

    private async Task FetchAsync(string directory, string relative, string remote, IDisposable lease, CancellationTokenSource stop)
    {
        // Disposed in reverse order: the lock is free before its CancellationTokenSource goes.
        using (stop)
        using (lease)
        using (var deadline = new GitDeadline(options.CurrentValue.NetworkTimeout, stop.Token))
        {
            try
            {
                // The runner logs the exit code, or that git was stopped.
                await git.RunAsync(directory, ["fetch", remote], deadline);
            }
            catch (Exception e) when (e is GitTimeoutException or OperationCanceledException)
            {
                // The time limit, a request that needs the repository, or the API stopping.
            }
            catch (Exception e)
            {
                // Logged by the relative path: responses and logs never contain resolved paths.
                log.LogWarning(e, "The background fetch in {Directory} failed", relative);
            }
        }
    }
}
