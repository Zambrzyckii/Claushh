// One lock per repository directory (docs/ARCHITECTURE.md, "Backend" → "Workspaces and git"): a clone (by its target),
// a pull and a push of one repository never run at the same time. A request waits for the lock within its deadline.
using System.Collections.Concurrent;

namespace Claushh.Api.Git;

public sealed class RepoLocks
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.Ordinal);

    public async Task<IDisposable> EnterAsync(string directory, GitDeadline deadline)
    {
        var gate = _locks.GetOrAdd(directory, _ => new SemaphoreSlim(1, 1));
        try
        {
            await gate.WaitAsync(deadline.Token);
        }
        catch (OperationCanceledException) when (deadline.Expired && !deadline.Aborted.IsCancellationRequested)
        {
            throw new GitTimeoutException(deadline.Limit);
        }
        return new Lease(gate);
    }

    private sealed class Lease(SemaphoreSlim gate) : IDisposable
    {
        public void Dispose() => gate.Release();
    }
}
