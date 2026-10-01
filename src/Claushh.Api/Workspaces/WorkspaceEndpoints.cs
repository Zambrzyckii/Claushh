// Workspaces and their repositories for the Workspace panel (docs/ARCHITECTURE.md, "Workspaces and git" → "API
// contract").
using System.Text.Json;
using Claushh.Api.Files;
using Claushh.Api.Git;

namespace Claushh.Api.Workspaces;

public static class WorkspaceEndpoints
{
    public sealed record CreateWorkspaceRequest(string? Name);
    public sealed record MessageResponse(string Message);

    public static RouteGroupBuilder MapWorkspaceEndpoints(this RouteGroupBuilder api)
    {
        api.MapGet("/workspaces", List);
        api.MapPost("/workspaces", Create);
        api.MapGet("/repos", Repos);
        return api;
    }

    private static async Task<IResult> List(WorkspaceStore workspaces, CancellationToken ct) =>
        Results.Ok(await workspaces.ListAsync(ct));

    private static async Task<IResult> Create(HttpContext http, WorkspaceStore workspaces)
    {
        var body = await ReadJsonAsync<CreateWorkspaceRequest>(http);
        var result = await workspaces.CreateAsync(body?.Name, http.RequestAborted);
        return result.Status switch
        {
            CreateStatus.Created => Results.Json(result.Workspace, statusCode: StatusCodes.Status201Created),
            CreateStatus.Exists => Results.Conflict(new MessageResponse("Workspace już istnieje.")),
            _ => Results.BadRequest(new MessageResponse("Nieprawidłowa nazwa.")),
        };
    }

    private static IResult Repos(string? workspace, WorkspaceStore workspaces, Repositories repositories)
    {
        if (workspaces.Find(workspace) is not { } directory)
        {
            return Results.BadRequest();
        }
        return directory.Kind == PathKind.Directory ? Results.Ok(repositories.List(directory)) : Results.NotFound();
    }

    // null for a body that is missing, not JSON or of the wrong shape. Read by hand, as in AuthEndpoints.Logout: with an
    // inferred JSON body, routing skips the endpoint for a request without a JSON content type, and the catch-all /api
    // route would answer 404 instead of 400.
    private static async Task<T?> ReadJsonAsync<T>(HttpContext http) where T : class
    {
        if (!http.Request.HasJsonContentType())
        {
            return null;
        }
        try
        {
            return await http.Request.ReadFromJsonAsync<T>(http.RequestAborted);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
