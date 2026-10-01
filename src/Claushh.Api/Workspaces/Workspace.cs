// The display name and creation time of a workspace (docs/ARCHITECTURE.md, "Workspaces and git"). The directory
// decides whether the workspace exists; a row whose directory is gone is ignored and kept.
namespace Claushh.Api.Workspaces;

public sealed class Workspace
{
    public required string Directory { get; set; }
    public required string DisplayName { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
