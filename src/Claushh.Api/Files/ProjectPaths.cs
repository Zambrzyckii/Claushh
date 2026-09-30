// The only code that turns an API path (relative to the projects directory, "/" separators) into a real path on disk.
// It refuses everything that leads outside the projects directory or into .git, also through symlinks
// (docs/ARCHITECTURE.md, "Files and editor"; decisions: docs/PLAN.md, "Backend decisions (stage 2)"). The files API
// uses it now; workspaces, git, the terminal and the console will too.
using Microsoft.Extensions.Options;

namespace Claushh.Api.Files;

// Missing: the name is free in an existing directory (a save may create it). NotFound: neither exists.
public enum PathKind { Directory, File, Other, Missing, NotFound }

// Relative: the path as the client sent it. FullPath: the real path on disk; for Missing the real directory plus the
// name, for NotFound empty.
public sealed record ProjectPath(string Relative, string FullPath, PathKind Kind);

public sealed class ProjectPaths(IOptions<ProjectsOptions> options)
{
    private const string Git = ".git";

    private static readonly EnumerationOptions AllEntries = new() { AttributesToSkip = 0, IgnoreInaccessible = true };

    private readonly Lazy<string> _root = new(() => Libc.RealPath(options.Value.Root, out _) is { } root and not "/"
        ? root
        : throw new InvalidOperationException("Projects:Root must be an existing directory other than /."));

    public string Root => _root.Value;

    // null: a bad path, one that leads outside the projects directory or into .git, or one that ends in a dangling or
    // looping symlink; all of them are answered with 400.
    public ProjectPath? Resolve(string relative)
    {
        if (!IsWellFormed(relative))
        {
            return null;
        }
        var joined = relative.Length == 0 ? Root : Path.Join(Root, relative);
        if (Libc.RealPath(joined, out var errno) is { } real)
        {
            return IsAllowed(real) ? new ProjectPath(relative, real, KindOf(real)) : null;
        }
        // The name exists but does not resolve: a dangling symlink, or a loop.
        if (errno == Libc.ELOOP || Libc.FileType(joined) is not null)
        {
            return null;
        }
        if (errno is not (Libc.ENOENT or Libc.ENOTDIR))
        {
            throw new IOException($"realpath failed with errno {errno}.");
        }
        var directory = Libc.RealPath(Path.GetDirectoryName(joined)!, out _);
        if (directory is null || Libc.FileType(directory) != Libc.S_IFDIR)
        {
            return new ProjectPath(relative, "", PathKind.NotFound);
        }
        return IsAllowed(directory)
            ? new ProjectPath(relative, Path.Join(directory, Path.GetFileName(joined)), PathKind.Missing)
            : null;
    }

    // The directories and regular files in a directory, symlinks inside the projects directory included (with their
    // target's kind); .git, links that lead out or nowhere, and special files are left out.
    public IEnumerable<ProjectPath> List(ProjectPath directory)
    {
        foreach (var path in Directory.EnumerateFileSystemEntries(directory.FullPath, "*", AllEntries))
        {
            var name = Path.GetFileName(path);
            if (name == Git)
            {
                continue;
            }
            var entry = Resolve(directory.Relative.Length == 0 ? name : $"{directory.Relative}/{name}");
            if (entry?.Kind is PathKind.Directory or PathKind.File)
            {
                yield return entry;
            }
        }
    }

    // What the frontend sends (web/src/app/core/api/project-path.ts) and nothing else: "" or non-empty segments joined
    // by "/", none of them ".", ".." or ".git", no "\" and no NUL.
    private static bool IsWellFormed(string relative) =>
        relative.Length == 0 || relative.Split('/').All(segment =>
            segment.Length > 0 && segment is not ("." or ".." or Git) && !segment.Contains('\\') && !segment.Contains('\0'));

    private bool IsAllowed(string real) =>
        real == Root || (real.StartsWith(Root + "/", StringComparison.Ordinal) && !real[(Root.Length + 1)..].Split('/').Contains(Git));

    private static PathKind KindOf(string real) => Libc.FileType(real) switch
    {
        Libc.S_IFDIR => PathKind.Directory,
        Libc.S_IFREG => PathKind.File,
        null => PathKind.NotFound,
        _ => PathKind.Other,
    };
}
