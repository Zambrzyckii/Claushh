// Repositories and their state, read in-process with LibGit2Sharp (docs/ARCHITECTURE.md, "Workspaces and git";
// decisions: docs/PLAN.md, "Backend decisions (stage 4)"). A repository is a real directory directly in a workspace,
// whose .git is a real directory and which libgit2 opens; anything else is not listed and is a 404. Repositories are
// opened for one call (for IgnoreRules, one search's walk) and disposed, never shared between threads.
using Claushh.Api.Files;
using LibGit2Sharp;

namespace Claushh.Api.Git;

public sealed record CommitInfo(string Message, DateTime Date);

public sealed record RepoSummary(string Name, string Path, string? Branch, int Changes, string? Upstream, int Ahead, int Behind, CommitInfo? LastCommit);

// A listed repository with what the background fetch needs: its directory and the remote of its upstream (null without
// one).
public sealed record RepoEntry(RepoSummary Summary, string Directory, string? Remote);

public sealed record FileChange(string Path, string Status);

public sealed record RepoStatus(string? Branch, int Ahead, int Behind, IReadOnlyList<FileChange> Files);

// Branch: null for a detached HEAD. Upstream: the tracked remote branch ("origin/main"), with Remote and MergeRef (the
// branch on the remote) from the branch's configuration; without one, Ahead and Behind are 0. AheadKnown: whether
// libgit2 could compute Ahead (false when the tracked branch has no tip, or there is no common ancestor); callers that
// must not treat an unknown ahead as zero (e.g. push) check this instead of Ahead. Sha: HEAD's commit, null on a
// branch without commits.
public sealed record HeadState(string? Branch, string? Upstream, string? Remote, string? MergeRef, int Ahead, bool AheadKnown, int Behind, string? Sha, bool HasOrigin);

public enum ShowStatus { Ok, NotFound, TooLarge, NotText }

public sealed record ShowResult(ShowStatus Status, string Content = "");

// The .gitignore rules of one repository, for search (docs/ARCHITECTURE.md, "Backend" → "Files"): from
// Repositories.Ignores, disposed by the caller and used from one thread.
public sealed class IgnoreRules(Repository repository, string repo) : IDisposable
{
    // Whether git ignores `path` (relative to the projects directory, inside the repository): the .gitignore files on the
    // way and the configured excludes, also for a tracked file. A directory is asked with a trailing "/", which libgit2
    // takes as a directory.
    public bool IsIgnored(string path, bool directory) =>
        repository.Ignore.IsPathIgnored(path[(repo.Length + 1)..] + (directory ? "/" : ""));

    public void Dispose() => repository.Dispose();
}

public sealed class Repositories(ProjectPaths paths, ILogger<Repositories> log)
{
    private const string GitDirectory = ".git";

    // The repository at an API path "<workspace>/<repository>": null for a bad path (400), Kind NotFound for a valid
    // path that is not a repository (404), otherwise its directory.
    public ProjectPath? Find(string? relative)
    {
        if (relative is null || relative.Split('/').Length != 2 || paths.Resolve(relative) is not { } directory)
        {
            return null;
        }
        return IsCandidate(directory) && Open(directory, (_, found) => found) is not null
            ? directory
            : new ProjectPath(relative, "", PathKind.NotFound);
    }

    // The repositories directly in a workspace, by name: ordinal, ignoring case.
    public IReadOnlyList<RepoEntry> List(ProjectPath workspace) =>
        InWorkspace(workspace, (repository, directory) =>
            {
                var head = HeadOf(repository);
                return new RepoEntry(Summarize(repository, directory, head), directory.FullPath, head.Remote);
            })
            .OrderBy(entry => entry.Summary.Name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(entry => entry.Summary.Name, StringComparer.Ordinal)
            .ToList();

    public int Count(ProjectPath workspace) => InWorkspace(workspace, (_, directory) => directory).Count;

    public RepoSummary Summary(ProjectPath repo)
    {
        using var repository = new Repository(repo.FullPath);
        return Summarize(repository, repo, HeadOf(repository));
    }

    public HeadState Head(ProjectPath repo)
    {
        using var repository = new Repository(repo.FullPath);
        return HeadOf(repository);
    }

    // The .gitignore rules of a repository that Find accepted, for search.
    public IgnoreRules Ignores(ProjectPath repo) => new(new Repository(repo.FullPath), repo.Relative);

    // The number of commits in HEAD's history: for push's message when Ahead is unknown (no common history with the
    // upstream, e.g. a freshly cloned empty remote), every local commit is one that push sends.
    public int CommitCount(ProjectPath repo)
    {
        using var repository = new Repository(repo.FullPath);
        return repository.Head.Commits.Count();
    }

    // null when libgit2 cannot read the status (e.g. a broken index): logged, and answered as not a repository (404),
    // as the list leaves such a repository out.
    public RepoStatus? Status(ProjectPath repo) => Open(repo, (repository, directory) =>
    {
        var head = HeadOf(repository);
        return new RepoStatus(head.Branch, head.Ahead, head.Behind, Changes(repository, directory.Relative));
    });

    // The file at `path` (relative to the projects directory, inside `repo`) as HEAD has it, through the filters a
    // checkout applies (line endings and ident from .gitattributes), so the diff view compares like with like.
    public ShowResult Show(ProjectPath repo, string path)
    {
        using var repository = new Repository(repo.FullPath);
        var inRepository = path[(repo.Relative.Length + 1)..];
        // Only a file: a tree is a directory, a GitLink a submodule, and a symlink's blob is its target.
        if (repository.Head.Tip?[inRepository] is not { TargetType: TreeEntryTargetType.Blob, Mode: not Mode.SymbolicLink, Target: Blob blob })
        {
            return new(ShowStatus.NotFound);
        }
        // Refused before it is read: the filters of a checkout add bytes (CR, the ident hash) rather than remove them.
        if (blob.Size > FileStore.MaxBytes)
        {
            return new(ShowStatus.TooLarge);
        }
        using var content = blob.GetContentStream(new FilteringOptions(inRepository));
        using var bytes = new MemoryStream();
        content.CopyTo(bytes);
        if (bytes.Length > FileStore.MaxBytes)
        {
            return new(ShowStatus.TooLarge);
        }
        return FileStore.DecodeText(bytes.GetBuffer().AsSpan(0, (int)bytes.Length)) is { } text
            ? new(ShowStatus.Ok, text)
            : new(ShowStatus.NotText);
    }

    private List<T> InWorkspace<T>(ProjectPath workspace, Func<Repository, ProjectPath, T> read) where T : class
    {
        var results = new List<T>();
        foreach (var directory in paths.List(workspace).Where(IsCandidate))
        {
            if (Open(directory, read) is { } result)
            {
                results.Add(result);
            }
        }
        return results;
    }

    // null when libgit2 cannot read the repository (a ref format or an extension it does not know, a broken .git):
    // that is logged, and the repository is left out. Also null, without a log, when it opens but does not point
    // here (a configuration problem, not a read failure): then it is simply not a repository here.
    private T? Open<T>(ProjectPath directory, Func<Repository, ProjectPath, T> read) where T : class
    {
        try
        {
            using var repository = new Repository(directory.FullPath);
            // core.worktree (or any other way to move the working directory, or libgit2's own .git path) could lead
            // outside this directory, also outside the projects directory: then this is not a repository here.
            var expectedGitPath = Path.Join(directory.FullPath, GitDirectory) + Path.DirectorySeparatorChar;
            var expectedWorkingDirectory = directory.FullPath + Path.DirectorySeparatorChar;
            if (repository.Info.Path != expectedGitPath || repository.Info.WorkingDirectory != expectedWorkingDirectory)
            {
                return null;
            }
            return read(repository, directory);
        }
        catch (LibGit2SharpException e)
        {
            log.LogWarning(e, "The repository {Path} cannot be read", directory.Relative);
            return null;
        }
    }

    // A real directory (no symlink on the way), no name starting with ".", and a .git that is a real directory: a .git
    // file (a worktree, a submodule) could point anywhere, also outside the projects directory. Checked before libgit2
    // opens it, because libgit2 follows such a file. A `.git/commondir` (a linked worktree's common .git, normally
    // reached through a `.git` file rather than a directory) is refused the same way, before it is opened.
    private bool IsCandidate(ProjectPath directory) =>
        directory.Kind == PathKind.Directory
        && directory.FullPath == Path.Join(paths.Root, directory.Relative)
        && !directory.Relative.Split('/').Any(name => name.StartsWith('.'))
        && Libc.FileType(Path.Join(directory.FullPath, GitDirectory)) == Libc.S_IFDIR
        && Libc.FileType(Path.Join(directory.FullPath, GitDirectory, "commondir")) is null;

    private static RepoSummary Summarize(Repository repository, ProjectPath directory, HeadState head)
    {
        var tip = repository.Head.Tip;
        return new RepoSummary(
            Path.GetFileName(directory.Relative),
            directory.Relative,
            head.Branch,
            Changes(repository, directory.Relative).Count,
            head.Upstream,
            head.Ahead,
            head.Behind,
            tip is null ? null : new CommitInfo(tip.MessageShort, tip.Committer.When.UtcDateTime));
    }

    private static HeadState HeadOf(Repository repository)
    {
        var head = repository.Head;
        var branch = repository.Info.IsHeadDetached ? null : head.FriendlyName;
        var tracked = branch is null ? null : head.TrackedBranch;
        // Unknown (no common ancestor, or the tracked branch has no tip yet, e.g. a freshly cloned empty remote):
        // AheadBy is null. That must not become 0, or push would believe there is nothing to send.
        var aheadKnown = tracked is not null && tracked.Tip is not null && head.TrackingDetails.AheadBy is not null;
        return new HeadState(
            branch,
            tracked?.FriendlyName,
            tracked is null ? null : head.RemoteName,
            tracked is null ? null : head.UpstreamBranchCanonicalName,
            aheadKnown ? head.TrackingDetails.AheadBy!.Value : 0,
            aheadKnown,
            // On a branch without commits yet, every commit of the upstream is still to come; on a tracked branch
            // without a tip either (e.g. a freshly cloned, completely empty remote), there is nothing to count.
            tracked is null ? 0 : head.Tip is null ? (tracked.Tip is null ? 0 : tracked.Commits.Count()) : head.TrackingDetails.BehindBy ?? 0,
            head.Tip?.Sha,
            repository.Config.Get<string>("remote.origin.url") is not null);
    }

    // What `git status` shows, one entry per file (also inside untracked directories; a repository inside them is one
    // entry for its directory, without git's trailing "/"), paths relative to the projects directory.
    private static List<FileChange> Changes(Repository repository, string repo)
    {
        var options = new StatusOptions
        {
            IncludeUntracked = true,
            RecurseUntrackedDirs = true,
            IncludeIgnored = false,
            DetectRenamesInIndex = true,
            DetectRenamesInWorkDir = false,
        };
        var changes = new List<FileChange>();
        foreach (var entry in repository.RetrieveStatus(options))
        {
            if (StatusOf(entry.State) is { } status)
            {
                changes.Add(new FileChange($"{repo}/{entry.FilePath.TrimEnd('/')}", status));
            }
        }
        return changes;
    }

    // The contract's statuses; the first match wins.
    private static string? StatusOf(FileStatus state) => state switch
    {
        _ when state.HasFlag(FileStatus.Conflicted) => "conflicted",
        _ when state.HasFlag(FileStatus.NewInIndex) => "added",
        _ when state.HasFlag(FileStatus.RenamedInIndex) => "renamed",
        _ when (state & (FileStatus.DeletedFromIndex | FileStatus.DeletedFromWorkdir)) != 0 => "deleted",
        _ when (state & (FileStatus.ModifiedInIndex | FileStatus.ModifiedInWorkdir | FileStatus.TypeChangeInIndex
            | FileStatus.TypeChangeInWorkdir)) != 0 => "modified",
        _ when state.HasFlag(FileStatus.NewInWorkdir) => "untracked",
        _ => null,
    };
}
