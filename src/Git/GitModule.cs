// What git adds to the host (Program.cs calls it in a fixed order, docs/ARCHITECTURE.md, "Repository map").
namespace Claushh.Api.Git;

public static class GitModule
{
    public static IServiceCollection AddGit(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<GitOptions>()
            .Bind(configuration.GetSection("Git"))
            .Validate(options => options.NetworkTimeout > TimeSpan.Zero, "Git:NetworkTimeout must be a positive time span.")
            .ValidateOnStart();
        services.AddSingleton<Repositories>();
        services.AddSingleton<GitRunner>();
        services.AddSingleton<RepoLocks>();
        services.AddSingleton<BackgroundFetch>();
        services.AddSingleton<RemoteOperations>();
        return services;
    }
}
