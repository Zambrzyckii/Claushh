// Git's remote operations (docs/ARCHITECTURE.md, "Workspaces and git"; decisions: docs/PLAN.md, "Backend decisions
// (stage 4)"): pull, push and clone, each under the repository's lock and within one Git:NetworkTimeout, with git's own
// messages (pull and push replace the resolved path with the API path) and a typed outcome that the endpoints map to
// status codes.
using Claushh.Api.Platform;
using Claushh.Api.Projects;
using Microsoft.Extensions.Options;

namespace Claushh.Api.Git;

// How a pull, push or clone ended. InvalidState is the repository's own state (no upstream, a detached HEAD, no
// origin), Conflict a refused merge or push or a clone target that exists, Failed any other failure, the timeout
// included.
public enum RemoteStatus { Done, InvalidState, Conflict, Failed }

public sealed record RemoteResult(RemoteStatus Status, string Message = "", IReadOnlyList<string>? ChangedPaths = null);

public sealed class RemoteOperations(Repositories repositories, RepoLocks locks, GitRunner git,
    IOptionsMonitor<GitOptions> options)
{
    public async Task<RemoteResult> PullAsync(ProjectPath repository, CancellationToken aborted)
    {
        using var deadline = new GitDeadline(options.CurrentValue.NetworkTimeout, aborted);
        try
        {
            using var held = await locks.EnterAsync(repository.FullPath, deadline);
            var before = repositories.Head(repository);
            if (before is not { Upstream: not null, Remote: { } remote })
            {
                return new RemoteResult(RemoteStatus.InvalidState, "The branch has no upstream.");
            }
            var fetch = await git.RunAsync(repository.FullPath, ["fetch", remote], deadline);
            if (!fetch.Succeeded)
            {
                return new RemoteResult(RemoteStatus.Failed, Redacted(fetch.Message, repository));
            }
            var behind = repositories.Head(repository).Behind;
            if (behind == 0)
            {
                return new RemoteResult(RemoteStatus.Done, "Already up to date.", []);
            }
            var merge = await git.RunAsync(repository.FullPath, ["merge", "--ff-only", "@{upstream}"], deadline, GitRunner.LocalStepLimit);
            if (!merge.Succeeded)
            {
                return new RemoteResult(RemoteStatus.Conflict, Redacted(merge.Message, repository));
            }
            // Both paths of a rename (--no-renames); on a branch that had no commits, every file of the new HEAD.
            string[] listing = before.Sha is { } old
                ? ["diff", "--name-only", "--no-renames", "-z", old, "HEAD"]
                : ["ls-tree", "-r", "--name-only", "-z", "HEAD"];
            var changed = await git.RunAsync(repository.FullPath, listing, deadline, GitRunner.LocalStepLimit);
            IReadOnlyList<string> paths = changed.Succeeded
                ? changed.Output.Split('\0', StringSplitOptions.RemoveEmptyEntries).Select(path => $"{repository.Relative}/{path}").ToList()
                : [];
            return new RemoteResult(RemoteStatus.Done, $"Pulled {behind} {Commits(behind)}.", paths);
        }
        catch (GitTimeoutException e)
        {
            return new RemoteResult(RemoteStatus.Failed, e.ResponseMessage);
        }
    }

    public async Task<RemoteResult> PushAsync(ProjectPath repository, CancellationToken aborted)
    {
        using var deadline = new GitDeadline(options.CurrentValue.NetworkTimeout, aborted);
        try
        {
            using var held = await locks.EnterAsync(repository.FullPath, deadline);
            var head = repositories.Head(repository);
            if (head.Branch is not { } branch)
            {
                return new RemoteResult(RemoteStatus.InvalidState, "Detached HEAD: switch to a branch to push.");
            }
            string[] arguments;
            string pushed;
            if (head is { Upstream: { } upstream, Remote: { } remote, MergeRef: { } mergeRef })
            {
                if (head.AheadKnown && head.Ahead == 0)
                {
                    return new RemoteResult(RemoteStatus.Done, "Nothing to push.");
                }
                arguments = ["push", "--porcelain", remote, $"HEAD:{mergeRef}"];
                // Ahead unknown (no common history with the upstream, e.g. a freshly cloned empty remote): every
                // commit of HEAD is one that this push sends.
                var count = head.AheadKnown ? head.Ahead : repositories.CommitCount(repository);
                pushed = $"Pushed {count} {Commits(count)} to {upstream}.";
            }
            else if (head.HasOrigin)
            {
                arguments = ["push", "--porcelain", "-u", "origin", "HEAD"];
                pushed = $"Pushed branch {branch} to origin/{branch}.";
            }
            else
            {
                return new RemoteResult(RemoteStatus.InvalidState, "No remote 'origin'.");
            }
            var push = await git.RunAsync(repository.FullPath, arguments, deadline);
            // --porcelain: a line per ref, starting with "!" for one that was refused.
            var refused = push.Output.Split('\n').Where(line => line.StartsWith('!')).ToList();
            if (push.Succeeded && refused.Count == 0)
            {
                return new RemoteResult(RemoteStatus.Done, pushed);
            }
            var message = Redacted(push.Message, repository);
            return refused.Any(line => line.Contains("\t[rejected]", StringComparison.Ordinal))
                ? new RemoteResult(RemoteStatus.Conflict, message)
                : new RemoteResult(RemoteStatus.Failed, message);
        }
        catch (GitTimeoutException e)
        {
            return new RemoteResult(RemoteStatus.Failed, e.ResponseMessage);
        }
    }

    public async Task<RemoteResult> CloneAsync(ProjectPath workspace, string url, string name, CancellationToken aborted)
    {
        var target = Path.Join(workspace.FullPath, name);
        using var deadline = new GitDeadline(options.CurrentValue.NetworkTimeout, aborted);
        try
        {
            using (await locks.EnterAsync(target, deadline))
            {
                if (Libc.FileType(target) is not null)
                {
                    return new RemoteResult(RemoteStatus.Conflict, "Directory already exists.");
                }
                GitResult result;
                try
                {
                    // The destination is given by name, not by the resolved target path: git's own "Cloning into '…'"
                    // message would otherwise put the resolved projects path in a 502 response.
                    result = await git.RunAsync(workspace.FullPath, ["clone", "--", url, name], deadline);
                }
                catch
                {
                    // Killed at the time limit or because the client went away: git had no chance to clean up.
                    RemovePartialClone(target);
                    throw;
                }
                if (!result.Succeeded)
                {
                    RemovePartialClone(target);
                    return new RemoteResult(RemoteStatus.Failed, result.Message);
                }
            }
        }
        catch (GitTimeoutException e)
        {
            return new RemoteResult(RemoteStatus.Failed, e.ResponseMessage);
        }
        return new RemoteResult(RemoteStatus.Done);
    }

    // git's own messages can repeat the repository's resolved path (e.g. a stale index.lock); the response gets the
    // API path instead, so responses never contain resolved paths.
    private static string Redacted(string message, ProjectPath repository) =>
        message.Replace(repository.FullPath, repository.Relative, StringComparison.Ordinal);

    // English plural: 1 commit, otherwise commits.
    private static string Commits(int count) => count == 1 ? "commit" : "commits";

    // The target was free before git ran, under its lock, so whatever is there now is git's.
    private static void RemovePartialClone(string target)
    {
        if (Libc.FileType(target) == Libc.S_IFDIR)
        {
            Directory.Delete(target, recursive: true);
        }
    }
}
