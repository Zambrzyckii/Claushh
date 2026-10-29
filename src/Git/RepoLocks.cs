// One lock per repository directory (docs/ARCHITECTURE.md, "Backend" → "Workspaces and git"): a clone (by its target),
// a pull, a push and the background fetch of one repository never run at the same time. A request waits for the lock
// within its deadline and stops a background fetch that holds it; a background fetch never waits.
using System.Collections.Concurrent;

namespace Claushh.Api.Git;

public sealed class RepoLocks
{
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);

    public async Task<IDisposable> EnterAsync(string directory, GitDeadline deadline)
    {
        var entry = _entries.GetOrAdd(directory, _ => new Entry());
        CancellationTokenSource? fetch;
        lock (entry)
        {
            entry.Waiting++;
            fetch = entry.Fetch;
        }
        try
        {
            try
            {
                // The request goes first; a pull fetches anyway.
                fetch?.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // The fetch has just finished.
            }
            await entry.Gate.WaitAsync(deadline.Token);
        }
        catch (OperationCanceledException) when (deadline.Expired && !deadline.Aborted.IsCancellationRequested)
        {
            throw new GitTimeoutException(deadline.Limit);
        }
        finally
        {
            lock (entry)
            {
                entry.Waiting--;
            }
        }
        return new Lease(entry, isFetch: false);
    }

    // The lock for a background fetch when it is free and no request waits for it, otherwise null. A request that comes
    // later cancels `fetch` to take the lock.
    public IDisposable? TryEnterForFetch(string directory, CancellationTokenSource fetch)
    {
        var entry = _entries.GetOrAdd(directory, _ => new Entry());
        lock (entry)
        {
            if (entry.Waiting > 0 || !entry.Gate.Wait(0))
            {
                return null;
            }
            entry.Fetch = fetch;
        }
        return new Lease(entry, isFetch: true);
    }

    // Waiting and Fetch change under lock (entry), so a request either sees the fetch that holds the lock and cancels
    // it, or the fetch sees the waiting request and does not start.
    private sealed class Entry
    {
        public SemaphoreSlim Gate { get; } = new(1, 1);
        public int Waiting { get; set; }
        public CancellationTokenSource? Fetch { get; set; }
    }

    private sealed class Lease(Entry entry, bool isFetch) : IDisposable
    {
        public void Dispose()
        {
            if (isFetch)
            {
                lock (entry)
                {
                    entry.Fetch = null;
                }
            }
            entry.Gate.Release();
        }
    }
}
