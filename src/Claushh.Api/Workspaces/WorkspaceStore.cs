// Workspaces: the real directories directly in the projects directory, with their display names and creation order
// from the Workspaces table (docs/ARCHITECTURE.md, "Workspaces and git"; decisions: docs/PLAN.md, "Backend decisions
// (stage 4)"). The file system decides which workspaces exist.
using Claushh.Api.Data;
using Claushh.Api.Files;
using Claushh.Api.Git;
using Microsoft.EntityFrameworkCore;

namespace Claushh.Api.Workspaces;

public sealed record WorkspaceInfo(string Name, string Path, int RepoCount);

public enum CreateStatus { Created, InvalidName, Exists }

public sealed record CreateResult(CreateStatus Status, WorkspaceInfo? Workspace = null);

public sealed class WorkspaceStore(ProjectPaths paths, Repositories repositories, ClaushhDbContext db, TimeProvider clock)
{
    // Workspaces are created one at a time in this process: the check of the name, mkdir and the row never interleave.
    private static readonly SemaphoreSlim CreateGate = new(1, 1);

    // The workspace at an API path (one segment): null for a bad path (400), Kind NotFound for a valid path that is not
    // a workspace (404), otherwise its directory.
    public ProjectPath? Find(string? relative)
    {
        if (relative is not { Length: > 0 } || relative.Contains('/') || paths.Resolve(relative) is not { } directory)
        {
            return null;
        }
        return IsWorkspace(directory) ? directory : new ProjectPath(relative, "", PathKind.NotFound);
    }

    // The workspaces with a row in creation order, then the directories made outside the portal by name (ordinal,
    // ignoring case) under their directory name. A row without its directory is left out.
    public async Task<IReadOnlyList<WorkspaceInfo>> ListAsync(CancellationToken ct)
    {
        var rows = await db.Workspaces.AsNoTracking().ToDictionaryAsync(row => row.Directory, ct);
        return paths.List(paths.Resolve("")!)
            .Where(IsWorkspace)
            .Select(directory => (Directory: directory, Row: rows.GetValueOrDefault(directory.Relative)))
            .OrderBy(entry => entry.Row is null)
            .ThenBy(entry => entry.Row?.CreatedAt)
            .ThenBy(entry => entry.Directory.Relative, StringComparer.OrdinalIgnoreCase)
            .ThenBy(entry => entry.Directory.Relative, StringComparer.Ordinal)
            .Select(entry => new WorkspaceInfo(
                entry.Row?.DisplayName ?? entry.Directory.Relative, entry.Directory.Relative, repositories.Count(entry.Directory)))
            .ToList();
    }

    // The directory first, then the row; when the row cannot be written, the new empty directory goes again and the
    // exception makes the request a 500.
    public async Task<CreateResult> CreateAsync(string? name, CancellationToken ct)
    {
        var trimmed = name is null ? "" : WorkspaceNames.Trim(name);
        var directory = WorkspaceNames.IsValid(trimmed) ? WorkspaceNames.DirectoryOf(trimmed) : "";
        if (directory.Length == 0)
        {
            return new(CreateStatus.InvalidName);
        }
        var fullPath = Path.Join(paths.Root, directory);
        await CreateGate.WaitAsync(ct);
        try
        {
            // Any entry with that name: a directory, a file or a symlink, also a dangling one.
            if (Libc.FileType(fullPath) is not null)
            {
                return new(CreateStatus.Exists);
            }
            Directory.CreateDirectory(fullPath);
            try
            {
                var now = clock.GetUtcNow();
                if (await db.Workspaces.FindAsync([directory], ct) is { } stale)
                {
                    // The row of a workspace whose directory is gone: the new one takes its place.
                    stale.DisplayName = trimmed;
                    stale.CreatedAt = now;
                }
                else
                {
                    db.Workspaces.Add(new Workspace { Directory = directory, DisplayName = trimmed, CreatedAt = now });
                }
                await db.SaveChangesAsync(ct);
            }
            catch
            {
                Directory.Delete(fullPath);
                throw;
            }
            return new(CreateStatus.Created, new WorkspaceInfo(trimmed, directory, 0));
        }
        finally
        {
            CreateGate.Release();
        }
    }

    // A real directory (not a symlink) whose name does not start with ".".
    private bool IsWorkspace(ProjectPath directory) =>
        directory.Kind == PathKind.Directory
        && directory.FullPath == Path.Join(paths.Root, directory.Relative)
        && !directory.Relative.StartsWith('.');
}
