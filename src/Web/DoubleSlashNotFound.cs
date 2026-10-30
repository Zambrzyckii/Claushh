// A path that starts with "//" is no path of the app, the API or the hubs (docs/ARCHITECTURE.md, "Backend" →
// "Frontend"): 404 with an empty body, before routing, the files of the build and authentication, also without
// Frontend:Root.
namespace Claushh.Api.Web;

public static class DoubleSlashNotFound
{
    // A path that starts with "//" is no path of the app, the API or the hubs: 404 with an empty body, before routing, the
    // files of the build and authentication.
    public static IApplicationBuilder UseDoubleSlashNotFound(this IApplicationBuilder app) => app.Use((context, next) =>
    {
        if (context.Request.Path.Value is { } path && path.StartsWith("//", StringComparison.Ordinal))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return Task.CompletedTask;
        }
        return next(context);
    });
}
