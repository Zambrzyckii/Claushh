// POST /api/search (docs/ARCHITECTURE.md, "Files and editor" → "Search API contract"): a POST keeps the searched text out
// of URLs, and so out of every proxy and access log. Every 400 comes before any file is read, and none has a body.
namespace Claushh.Api.Files;

public static class SearchEndpoints
{
    public sealed record SearchRequest(string? Path, string? Query, bool? MatchCase, bool? WholeWord, bool? Regex,
        string? Include, string? Exclude);

    public static RouteGroupBuilder MapSearchEndpoints(this RouteGroupBuilder api)
    {
        api.MapPost("/search", Search);
        return api;
    }

    private static IResult Search(SearchRequest? body, ProjectPaths paths, FileSearch search, CancellationToken ct)
    {
        if (body is not { Path: { } path, Query: { Length: >= 1 and <= FileSearch.MaxText } query }
            || body.Include is { Length: > FileSearch.MaxText } || body.Exclude is { Length: > FileSearch.MaxText }
            || FileSearch.Pattern(query, body.MatchCase ?? false, body.WholeWord ?? false, body.Regex ?? false) is not { } pattern
            || FileSearch.Globs(body.Include) is not (var include, true)
            || FileSearch.Globs(body.Exclude) is not (var exclude, true)
            || paths.Resolve(path) is not { } root)
        {
            return Results.BadRequest();
        }
        return root.Kind == PathKind.Directory
            ? Results.Ok(search.Run(root, pattern, include, exclude, ct))
            : Results.NotFound();
    }
}
