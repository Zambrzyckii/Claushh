// Workspaces and their repositories for the Workspace panel (docs/ARCHITECTURE.md, "Workspaces and git" → "API
// contract").
using System.Text.Json;
using Claushh.Api.Files;
using Claushh.Api.Git;
using Microsoft.Extensions.Options;

namespace Claushh.Api.Workspaces;

public static class WorkspaceEndpoints
{
    public sealed record CreateWorkspaceRequest(string? Name);
    public sealed record MessageResponse(string Message);
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
        var body = await ReadJsonAsync<CreateWorkspaceRequest>(http);
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
        if (workspaces.Find(workspace) is not { } directory)
        {
            return Results.BadRequest();
        }
        if (directory.Kind != PathKind.Directory)
        {
            return Results.NotFound();
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
        RepoLocks locks, GitRunner git, IOptionsMonitor<GitOptions> options)
    {
        var body = await ReadJsonAsync<CloneRequest>(http);
        if (body is null || workspaces.Find(body.Workspace) is not { } workspace)
        {
            return Results.BadRequest();
        }
        if (workspace.Kind != PathKind.Directory)
        {
            return Results.NotFound();
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
        using var deadline = new GitDeadline(options.CurrentValue.NetworkTimeout, http.RequestAborted);
        try
        {
            using (await locks.EnterAsync(target, deadline))
            {
                if (Libc.FileType(target) is not null)
                {
                    return Results.Conflict(new MessageResponse("Directory already exists."));
                }
                GitResult result;
                try
                {
                    // The destination is given by name, not by the resolved target path: git's own "Cloning into '…'"
                    // message would otherwise put the resolved projects path in a 502 response.
                    result = await git.RunAsync(workspace.FullPath, ["clone", "--", body.Url, name], deadline);
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
                    return Results.Json(new MessageResponse(result.Message), statusCode: StatusCodes.Status502BadGateway);
                }
            }
        }
        catch (GitTimeoutException e)
        {
            return Results.Json(new MessageResponse(e.ResponseMessage), statusCode: StatusCodes.Status502BadGateway);
        }
        // A clone must pass what a repository is, like any other.
        return repositories.Find($"{workspace.Relative}/{name}") is { Kind: PathKind.Directory } repository
            ? Results.Json(repositories.Summary(repository), statusCode: StatusCodes.Status201Created)
            : throw new InvalidOperationException($"The clone {workspace.Relative}/{name} is not a repository the portal can read.");
    }

    // The target was free before git ran, under its lock, so whatever is there now is git's.
    private static void RemovePartialClone(string target)
    {
        if (Libc.FileType(target) == Libc.S_IFDIR)
        {
            Directory.Delete(target, recursive: true);
        }
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
