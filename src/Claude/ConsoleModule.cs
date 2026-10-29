// What the console adds to the host (Program.cs calls it in a fixed order, docs/ARCHITECTURE.md, "Repository map").
namespace Claushh.Api.Claude;

public static class ConsoleModule
{
    public static IServiceCollection AddConsole(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<ConsoleOptions>(configuration.GetSection("Console"));
        services.AddSingleton<ClaudeCli>();
        services.AddSingleton<ConversationLog>();
        services.AddSingleton<EventWriter>();
        services.AddSingleton<Conversations>();
        // Prepares the claude CLI's config directory and ends turns left open at start, closes idle processes, stops them all
        // on a stop; create-user never starts the host, so it never runs this.
        services.AddHostedService(services => services.GetRequiredService<Conversations>());
        services.AddSingleton<ConversationCleanup>();
        services.AddHostedService(services => services.GetRequiredService<ConversationCleanup>());
        return services;
    }
}
