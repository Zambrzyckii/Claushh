// The files API for the explorer and the editor (docs/ARCHITECTURE.md, "Files and editor" → "Files API contract").
namespace Claushh.Api.Files;

public static class FileEndpoints
{
    public sealed record EntryResponse(string Name, string Path, string Kind);
    public sealed record FileResponse(string Path, string Content, string Version);
    public sealed record SaveRequest(string? Content, string? BaseVersion);
    public sealed record SavedResponse(string Version);
    public sealed record ConflictResponse(string CurrentVersion);

    public static RouteGroupBuilder MapFileEndpoints(this RouteGroupBuilder api)
    {
        var files = api.MapGroup("/files");
        files.MapGet("/list", List);
        files.MapGet("/content", Read);
        files.MapPut("/content", Save);
        return api;
    }

    private static IResult List(string? path, ProjectPaths paths)
    {
        var directory = paths.Resolve(path ?? "");
        if (directory is null)
        {
            return Results.BadRequest();
        }
        if (directory.Kind != PathKind.Directory)
        {
            return Results.NotFound();
        }
        var entries = paths.List(directory).Select(entry => new EntryResponse(
            Path.GetFileName(entry.Relative), entry.Relative, entry.Kind == PathKind.Directory ? "directory" : "file"));
        // Read the whole directory here, so that an IOException gives a 500 and not a response cut off half way.
        return Results.Ok(entries.ToList());
    }

    private static async Task<IResult> Read(string? path, ProjectPaths paths, FileStore store, CancellationToken ct)
    {
        if (paths.Resolve(path ?? "") is not { } file)
        {
            return Results.BadRequest();
        }
        var result = await store.ReadAsync(file, ct);
        return result.Status switch
        {
            ReadStatus.Ok => Results.Ok(new FileResponse(file.Relative, result.Content, result.Version)),
            ReadStatus.TooLarge => Results.StatusCode(StatusCodes.Status413PayloadTooLarge),
            ReadStatus.NotText => Results.StatusCode(StatusCodes.Status415UnsupportedMediaType),
            _ => Results.NotFound(),
        };
    }

    private static async Task<IResult> Save(string? path, SaveRequest? body, ProjectPaths paths, FileStore store, CancellationToken ct)
    {
        if (body is not { Content: { } content, BaseVersion: { } baseVersion } || paths.Resolve(path ?? "") is not { } file)
        {
            return Results.BadRequest();
        }
        var result = await store.SaveAsync(file, content, baseVersion, ct);
        return result.Status switch
        {
            SaveStatus.Saved => Results.Ok(new SavedResponse(result.Version)),
            SaveStatus.Conflict => Results.Conflict(new ConflictResponse(result.Version)),
            SaveStatus.TooLarge => Results.StatusCode(StatusCodes.Status413PayloadTooLarge),
            SaveStatus.NotText => Results.StatusCode(StatusCodes.Status415UnsupportedMediaType),
            SaveStatus.NotFound => Results.NotFound(),
            _ => Results.BadRequest(),
        };
    }
}
