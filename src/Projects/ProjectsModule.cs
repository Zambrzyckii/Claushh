// What the projects directory adds to the host (Program.cs calls it in a fixed order, docs/ARCHITECTURE.md, "Repository map").
using Claushh.Api.Platform;

namespace Claushh.Api.Projects;

public static class ProjectsModule
{
    public static IServiceCollection AddProjects(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<ProjectsOptions>()
            .Bind(configuration.GetSection("Projects"))
            .Validate(options => Path.IsPathFullyQualified(options.Root) && Directory.Exists(options.Root)
                    && Libc.RealPath(options.Root, out _) is not (null or "/"),
                "Projects:Root must be the absolute path of an existing directory other than / (README.md, \"Running in development\").")
            .Validate(options => Libc.CanReadWriteAndSearch(options.Root),
                "Projects:Root must be a directory the API can read, write and search (README.md, \"Running in development\").")
            .ValidateOnStart();
        services.AddSingleton<ProjectPaths>();
        return services;
    }
}
