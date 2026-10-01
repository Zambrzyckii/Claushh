// The git API for the explorer's badges, the status bar and the diff view (docs/ARCHITECTURE.md, "Workspaces and git"
// → "API contract").
using Claushh.Api.Files;

namespace Claushh.Api.Git;

public static class GitEndpoints
{
    public sealed record ShowResponse(string Content);

    public static RouteGroupBuilder MapGitEndpoints(this RouteGroupBuilder api)
    {
        var git = api.MapGroup("/git");
        git.MapGet("/status", Status);
        git.MapGet("/show", Show);
        return api;
    }

    private static IResult Status(string? repo, Repositories repositories)
    {
        if (repositories.Find(repo) is not { } repository)
        {
            return Results.BadRequest();
        }
        return repository.Kind == PathKind.Directory ? Results.Ok(repositories.Status(repository)) : Results.NotFound();
    }

    // `path` must be a valid path inside `repo`; it is looked up in HEAD, so a file deleted on disk still has content.
    private static IResult Show(string? repo, string? path, Repositories repositories, ProjectPaths paths)
    {
        if (repositories.Find(repo) is not { } repository || path is null
            || !path.StartsWith(repository.Relative + "/", StringComparison.Ordinal) || paths.Resolve(path) is null)
        {
            return Results.BadRequest();
        }
        if (repository.Kind != PathKind.Directory)
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
}
