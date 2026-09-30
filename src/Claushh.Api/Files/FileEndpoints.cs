// The files API for the explorer and the editor (docs/ARCHITECTURE.md, "Files and editor" → "Files API contract").
namespace Claushh.Api.Files;

public static class FileEndpoints
{
    public sealed record EntryResponse(string Name, string Path, string Kind);

    public static RouteGroupBuilder MapFileEndpoints(this RouteGroupBuilder api)
    {
        var files = api.MapGroup("/files");
        files.MapGet("/list", List);
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
        return Results.Ok(paths.List(directory).Select(entry => new EntryResponse(
            Path.GetFileName(entry.Relative), entry.Relative, entry.Kind == PathKind.Directory ? "directory" : "file")));
    }
}
