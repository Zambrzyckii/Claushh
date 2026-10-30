// What serving the built frontend adds to the host (Program.cs calls it in a fixed order, docs/ARCHITECTURE.md, "Repository map").
namespace Claushh.Api.Frontend;

public static class FrontendModule
{
    public static IServiceCollection AddFrontend(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<FrontendOptions>()
            .Bind(configuration.GetSection("Frontend"))
            .Validate(options => options.Root.Length == 0 || Path.IsPathFullyQualified(options.Root),
                "Frontend:Root must be empty or an absolute path (README.md, \"Running the built frontend\").")
            .Validate(options => !Path.IsPathFullyQualified(options.Root) || FrontendFiles.ReadPolicy(options.Root) is not null,
                "Frontend:Root must hold the frontend build: an index.html with a Content-Security-Policy <meta> (README.md, \"Running the built frontend\").")
            .ValidateOnStart();
        return services;
    }
}
