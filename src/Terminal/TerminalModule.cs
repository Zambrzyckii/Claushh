// What the terminal adds to the host (Program.cs calls it in a fixed order, docs/ARCHITECTURE.md, "Repository map").
namespace Claushh.Api.Terminal;

public static class TerminalModule
{
    public static IServiceCollection AddTerminal(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<TerminalOptions>(configuration.GetSection("Terminal"));
        services.AddSingleton<TmuxServer>();
        services.AddSingleton<Terminals>();
        // Prepares the tmux server at start and ends it on a stop; create-user never starts the host, so it never runs this.
        services.AddHostedService(services => services.GetRequiredService<Terminals>());
        return services;
    }
}
