// What the files API and the search in files add to the host (Program.cs calls it in a fixed order, docs/ARCHITECTURE.md, "Repository map").
namespace Claushh.Api.Files;

public static class FilesModule
{
    public static IServiceCollection AddFiles(this IServiceCollection services)
    {
        services.AddSingleton<FileStore>();
        services.AddSingleton<SearchLimits>();
        services.AddSingleton<FileSearch>();
        return services;
    }
}
