// The built Angular frontend, served by the API when Frontend:Root is set (docs/ARCHITECTURE.md, "Backend" → "Frontend";
// decisions: docs/PLAN.md, "Backend decisions (stage 1, part C)"). The files of the build go out before authentication,
// and index.html with its Content-Security-Policy header goes out for every path that does not look like a file.
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;

namespace Claushh.Api.Frontend;

public static partial class FrontendFiles
{
    private const string Index = "index.html";

    // The policy in index.html's Content-Security-Policy <meta> (web/src/index.html), read as the mock reads it
    // (web/e2e/mock-api/server.mjs, pageCsp); null without the file or the <meta>.
    public static string? ReadPolicy(string root)
    {
        var index = Path.Join(root, Index);
        if (!File.Exists(index))
        {
            return null;
        }
        var meta = PolicyMeta().Match(File.ReadAllText(index));
        return meta.Success ? meta.Groups[1].Value : null;
    }

    // One object for the files and the fallback, so both send the same headers; null when Frontend:Root is empty. The
    // policy is read once, so a build that changes it needs a restart.
    public static StaticFileOptions? Options(FrontendOptions frontend)
    {
        if (frontend.Root.Length == 0)
        {
            return null;
        }
        var policy = (ReadPolicy(frontend.Root) ?? throw new InvalidOperationException(
            "Frontend:Root must hold the frontend build: an index.html with a Content-Security-Policy <meta> (README.md, \"Running the built frontend\")."))
            + "; frame-ancestors 'none'";
        var types = new FileExtensionContentTypeProvider();
        // The framework's own types are application/x-font-ttf and application/font-woff; the mock sends font/ttf and
        // font/woff (.woff2 is font/woff2 in both).
        types.Mappings[".ttf"] = "font/ttf";
        types.Mappings[".woff"] = "font/woff";
        return new StaticFileOptions
        {
            FileProvider = new PhysicalFileProvider(frontend.Root),
            ContentTypeProvider = types,
            OnPrepareResponse = context =>
            {
                var headers = context.Context.Response.Headers;
                // The page, also through the fallback, which serves it as /index.html. Other files get no CSP: the
                // Monaco workers take their policy from their own response.
                if (context.Context.Request.Path == "/" + Index)
                {
                    headers.CacheControl = "no-store";
                    headers.ContentSecurityPolicy = policy;
                }
                else
                {
                    headers.CacheControl = "no-cache";
                }
            },
        };
    }

    // Before authentication: the files are the same for everyone and hold no data. Endpoint matching runs first
    // (Program.cs), so a request that matched /api, /hubs or the fallback is never answered from here.
    public static IApplicationBuilder UseFrontendFiles(this IApplicationBuilder app, StaticFileOptions? files) =>
        files is null ? app : app.UseStaticFiles(files);

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

    // index.html for every path that does not look like a file ({*path:nonfile}), so Angular's routes load. A missing file
    // such as /chunk-x.js matches nothing and gets 401 or 404 from the fallback policy.
    public static void MapFrontendFallback(this IEndpointRouteBuilder endpoints, StaticFileOptions? files)
    {
        if (files is not null)
        {
            endpoints.MapFallbackToFile(Index, files).AllowAnonymous();
        }
    }

    [GeneratedRegex(@"<meta http-equiv=""Content-Security-Policy"" content=""([^""]+)""")]
    private static partial Regex PolicyMeta();
}
