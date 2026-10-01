// Workspaces and their repositories for the Workspace panel (docs/ARCHITECTURE.md, "Workspaces and git" → "API
// contract").
using Claushh.Api.Files;
using Claushh.Api.Git;

namespace Claushh.Api.Workspaces;

public static class WorkspaceEndpoints
{
    public static RouteGroupBuilder MapWorkspaceEndpoints(this RouteGroupBuilder api)
    {
        api.MapGet("/repos", Repos);
        return api;
    }

    private static IResult Repos(string? workspace, WorkspaceStore workspaces, Repositories repositories)
    {
        if (workspaces.Find(workspace) is not { } directory)
        {
            return Results.BadRequest();
        }
        return directory.Kind == PathKind.Directory ? Results.Ok(repositories.List(directory)) : Results.NotFound();
    }
}
