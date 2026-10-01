// Git:NetworkTimeout (docs/ARCHITECTURE.md, "Backend", configuration): the one deadline of a clone, pull or push
// request, lock wait included, and of a background fetch.
namespace Claushh.Api.Git;

public sealed class GitOptions
{
    public TimeSpan NetworkTimeout { get; set; } = TimeSpan.FromSeconds(100);
}
