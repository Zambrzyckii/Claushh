// Workspaces and their repositories for the Workspace panel (docs/ARCHITECTURE.md, "Workspaces and git" → "API
// contract").
using Claushh.Api.Git;
using Claushh.Api.Platform;
using Claushh.Api.Projects;
using Claushh.Api.Web;

namespace Claushh.Api.Workspaces;

public static class WorkspaceEndpoints
{
    public sealed record CreateWorkspaceRequest(string? Name);
    public sealed record CloneRequest(string? Workspace, string? Url);

    public static RouteGroupBuilder MapWorkspaceEndpoints(this RouteGroupBuilder api)
    {
        api.MapGet("/workspaces", List);
        api.MapPost("/workspaces", Create);
        api.MapGet("/repos", Repos);
        api.MapPost("/repos/clone", Clone);
        return api;
    }

    private static async Task<IResult> List(WorkspaceStore workspaces, CancellationToken ct) =>
        Results.Ok(await workspaces.ListAsync(ct));

    private static async Task<IResult> Create(HttpContext http, WorkspaceStore workspaces)
    {
        var body = await JsonBody.ReadAsync<CreateWorkspaceRequest>(http);
        var result = await workspaces.CreateAsync(body?.Name, http.RequestAborted);
        return result.Status switch
        {
            CreateStatus.Created => Results.Json(result.Workspace, statusCode: StatusCodes.Status201Created),
            CreateStatus.Exists => Results.Conflict(new MessageResponse("Workspace already exists.")),
            _ => Results.BadRequest(new MessageResponse("Invalid name.")),
        };
    }

    // Never waits for the network: ↑/↓ count against the last fetch, and the repositories with an upstream are fetched
    // in the background for the panel's next refresh.
    private static IResult Repos(string? workspace, WorkspaceStore workspaces, Repositories repositories, BackgroundFetch fetch)
    {
        var lookup = workspaces.Find(workspace);
        if (lookup is not { Status: LookupStatus.Found, Path: { } directory })
        {
            return lookup.Status == LookupStatus.Invalid ? Results.BadRequest() : Results.NotFound();
        }
        var entries = repositories.List(directory);
        foreach (var entry in entries)
        {
            if (entry.Remote is { } remote)
            {
                fetch.Start(entry.Directory, entry.Summary.Path, remote);
            }
        }
        return Results.Ok(entries.Select(entry => entry.Summary).ToList());
    }

    // The mock's order of checks (body and workspace, URL, directory name, a free target), then git clone under the
    // target's lock, all within one Git:NetworkTimeout.
    private static async Task<IResult> Clone(HttpContext http, WorkspaceStore workspaces, Repositories repositories,
        RemoteOperations remote)
    {
        var body = await JsonBody.ReadAsync<CloneRequest>(http);
        if (body is null)
        {
            return Results.BadRequest();
        }
        var lookup = workspaces.Find(body.Workspace);
        if (lookup is not { Status: LookupStatus.Found, Path: { } workspace })
        {
            return lookup.Status == LookupStatus.Invalid ? Results.BadRequest() : Results.NotFound();
        }
        if (!CloneUrl.IsValid(body.Url))
        {
            return Results.BadRequest(new MessageResponse("Invalid URL."));
        }
        if (CloneUrl.DirectoryName(body.Url) is not { } name)
        {
            return Results.BadRequest(new MessageResponse("Invalid directory name."));
        }
        var target = Path.Join(workspace.FullPath, name);
        if (Libc.FileType(target) is not null)
        {
            return Results.Conflict(new MessageResponse("Directory already exists."));
        }
        var result = await remote.CloneAsync(workspace, body.Url!, name, http.RequestAborted);
        if (result.Status == RemoteStatus.Conflict)
        {
            return Results.Conflict(new MessageResponse(result.Message));
        }
        if (result.Status == RemoteStatus.Failed)
        {
            return Results.Json(new MessageResponse(result.Message), statusCode: StatusCodes.Status502BadGateway);
        }
        // A clone must pass what a repository is, like any other.
        return repositories.Find($"{workspace.Relative}/{name}") is { Status: LookupStatus.Found, Path: { } repository }
            ? Results.Json(repositories.Summary(repository), statusCode: StatusCodes.Status201Created)
            : throw new InvalidOperationException($"The clone {workspace.Relative}/{name} is not a repository the portal can read.");
    }
}
