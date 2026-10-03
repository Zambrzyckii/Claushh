// Frontend:Root (docs/ARCHITECTURE.md, "Backend", configuration): the absolute path of the Angular build the API serves,
// web/dist/web/browser. Empty: no frontend (development uses ng serve).
namespace Claushh.Api.Frontend;

public sealed class FrontendOptions
{
    public string Root { get; set; } = "";
}
