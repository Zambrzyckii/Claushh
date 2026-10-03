// The headers of docs/ARCHITECTURE.md, "Security headers", that go on every response, and Cache-Control: no-store on every
// /api response. The page's CSP comes from FrontendFiles. Registered before the error handler and authorization
// (Program.cs), so their 401, the Origin check's 403 and the error handler's 500 get the headers too.
namespace Claushh.Api.Frontend;

public static class SecurityHeaders
{
    public static IApplicationBuilder UseSecurityHeaders(this IApplicationBuilder app) => app.Use((context, next) =>
    {
        var api = context.Request.Path.StartsWithSegments("/api");
        context.Response.OnStarting(() =>
        {
            var headers = context.Response.Headers;
            headers.XFrameOptions = "DENY";
            headers.XContentTypeOptions = "nosniff";
            headers["Referrer-Policy"] = "no-referrer";
            headers["Cross-Origin-Opener-Policy"] = "same-origin";
            headers["Cross-Origin-Resource-Policy"] = "same-origin";
            headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";
            if (api)
            {
                headers.CacheControl = "no-store";
            }
            return Task.CompletedTask;
        });
        return next(context);
    });
}
