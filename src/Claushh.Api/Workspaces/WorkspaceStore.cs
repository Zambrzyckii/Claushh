// Workspaces: the real directories directly in the projects directory (docs/ARCHITECTURE.md, "Workspaces and git";
// decisions: docs/PLAN.md, "Backend decisions (stage 4)").
using Claushh.Api.Files;

namespace Claushh.Api.Workspaces;

public sealed class WorkspaceStore(ProjectPaths paths)
{
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

    // A real directory (not a symlink) whose name does not start with ".".
    private bool IsWorkspace(ProjectPath directory) =>
        directory.Kind == PathKind.Directory
        && directory.FullPath == Path.Join(paths.Root, directory.Relative)
        && !directory.Relative.StartsWith('.');
}
