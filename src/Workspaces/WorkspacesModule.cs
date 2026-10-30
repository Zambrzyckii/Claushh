// What workspaces add to the host (Program.cs calls it in a fixed order, docs/ARCHITECTURE.md, "Repository map").
namespace Claushh.Api.Workspaces;

public static class WorkspacesModule
{
    public static IServiceCollection AddWorkspaces(this IServiceCollection services)
    {
        services.AddScoped<WorkspaceStore>();
        return services;
    }
}
