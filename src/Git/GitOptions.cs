// Git:NetworkTimeout (docs/ARCHITECTURE.md, "Backend", configuration): the one deadline of a clone, pull or push
// request, lock wait included, and of a background fetch. Git:Environment:*: extra variables for the git CLI's
// environment (ChildEnvironment's overrides in GitRunner.StartInfo), e.g. for a credential helper's configuration.
namespace Claushh.Api.Git;

public sealed class GitOptions
{
    public TimeSpan NetworkTimeout { get; set; } = TimeSpan.FromSeconds(100);

    public Dictionary<string, string> Environment { get; set; } = new();
}
