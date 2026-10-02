// Refuses a request under /hubs whose Origin is not exactly one of Hubs:AllowedOrigins, with 403 and an empty body
// (docs/ARCHITECTURE.md, "Backend" → "Hubs"). Browsers send Origin with every WebSocket handshake, so a page of another
// site cannot open a hub with the owner's cookie; a request without Origin is refused too.
using Microsoft.Extensions.Options;

namespace Claushh.Api.Hubs;

public static class HubOrigins
{
    public static IApplicationBuilder UseHubOriginCheck(this IApplicationBuilder app) => app.Use((context, next) =>
    {
        if (!context.Request.Path.StartsWithSegments("/hubs"))
        {
            return next(context);
        }
        var origin = context.Request.Headers.Origin.ToString();
        var allowed = context.RequestServices.GetRequiredService<IOptions<HubsOptions>>().Value.AllowedOrigins;
        if (origin.Length > 0 && allowed.Contains(origin, StringComparer.Ordinal))
        {
            return next(context);
        }
        context.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("Claushh.Api.Hubs.HubOrigins")
            .LogInformation("Refused a hub request from origin {Origin}", origin);
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        return Task.CompletedTask;
    });
}
