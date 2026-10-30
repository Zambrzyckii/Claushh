// The git API for the explorer's badges, the status bar, the diff view and Pull / Push (docs/ARCHITECTURE.md,
// "Workspaces and git" → "API contract").
using Claushh.Api.Projects;
using Claushh.Api.Web;

namespace Claushh.Api.Git;

public static class GitEndpoints
{
    public sealed record ShowResponse(string Content);
    public sealed record PullResponse(string Message, IReadOnlyList<string> ChangedPaths);

    public static RouteGroupBuilder MapGitEndpoints(this RouteGroupBuilder api)
    {
        var git = api.MapGroup("/git");
        git.MapGet("/status", Status);
        git.MapGet("/show", Show);
        git.MapPost("/pull", Pull);
        git.MapPost("/push", Push);
        return api;
    }

    private static IResult Status(string? repo, Repositories repositories)
    {
        return repositories.Find(repo) switch
        {
            { Status: LookupStatus.Invalid } => Results.BadRequest(),
            { Status: LookupStatus.Found, Path: { } repository } when repositories.Status(repository) is { } status
                => Results.Ok(status),
            _ => Results.NotFound(),
        };
    }

    // `path` must be a valid path inside `repo`; it is looked up in HEAD, so a file deleted on disk still has content.
    private static IResult Show(string? repo, string? path, Repositories repositories, ProjectPaths paths)
    {
        var lookup = repositories.Find(repo);
        if (lookup.Status == LookupStatus.Invalid || path is null
            || !path.StartsWith(repo + "/", StringComparison.Ordinal) || paths.Resolve(path) is null)
        {
            return Results.BadRequest();
        }
        if (lookup is not { Status: LookupStatus.Found, Path: { } repository })
        {
            return Results.NotFound();
        }
        var result = repositories.Show(repository, path);
        return result.Status switch
        {
            ShowStatus.Ok => Results.Ok(new ShowResponse(result.Content)),
            ShowStatus.TooLarge => Results.StatusCode(StatusCodes.Status413PayloadTooLarge),
            ShowStatus.NotText => Results.StatusCode(StatusCodes.Status415UnsupportedMediaType),
            _ => Results.NotFound(),
        };
    }

    // `git pull --ff-only` as its two steps, so that the answer follows the step that failed: the fetch (502), then a
    // fast-forward merge (409). The lock and every step share one Git:NetworkTimeout.
    private static async Task<IResult> Pull(string? repo, HttpContext http, Repositories repositories,
        RemoteOperations remote)
    {
        var lookup = repositories.Find(repo);
        if (lookup is not { Status: LookupStatus.Found, Path: { } repository })
        {
            return lookup.Status == LookupStatus.Invalid ? Results.BadRequest() : Results.NotFound();
        }
        var result = await remote.PullAsync(repository, http.RequestAborted);
        return result.Status switch
        {
            RemoteStatus.Done => Results.Ok(new PullResponse(result.Message, result.ChangedPaths!)),
            RemoteStatus.InvalidState => Results.BadRequest(new MessageResponse(result.Message)),
            RemoteStatus.Conflict => Results.Conflict(new MessageResponse(result.Message)),
            _ => RemoteError(result.Message),
        };
    }

    // To the tracked branch with an explicit refspec, so push.default does not matter; without an upstream, the
    // contract's `git push -u origin HEAD`. A ref refused as [rejected] (the remote has newer commits) is 409; any other
    // failure (network, authentication, [remote rejected] by a hook or a protection rule) is 502.
    private static async Task<IResult> Push(string? repo, HttpContext http, Repositories repositories,
        RemoteOperations remote)
    {
        var lookup = repositories.Find(repo);
        if (lookup is not { Status: LookupStatus.Found, Path: { } repository })
        {
            return lookup.Status == LookupStatus.Invalid ? Results.BadRequest() : Results.NotFound();
        }
        var result = await remote.PushAsync(repository, http.RequestAborted);
        return result.Status switch
        {
            RemoteStatus.Done => Results.Ok(new MessageResponse(result.Message)),
            RemoteStatus.InvalidState => Results.BadRequest(new MessageResponse(result.Message)),
            RemoteStatus.Conflict => Results.Conflict(new MessageResponse(result.Message)),
            _ => RemoteError(result.Message),
        };
    }

    private static IResult RemoteError(string message) =>
        Results.Json(new MessageResponse(message), statusCode: StatusCodes.Status502BadGateway);
}
