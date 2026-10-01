// The workspace name rule and the directory made from a name, exactly as the frontend (workspaces/validation.ts) and the
// mock apply them (docs/ARCHITECTURE.md, "Workspaces and git"; decisions: docs/PLAN.md, "Backend decisions (stage 4)").
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Claushh.Api.Workspaces;

public static partial class WorkspaceNames
{
    private const int MaxLength = 40;

    // As JavaScript's String.prototype.trim(): .NET's Trim() would also remove U+0085 and keep U+FEFF.
    public static string Trim(string name)
    {
        var start = 0;
        var end = name.Length;
        while (start < end && IsJsWhiteSpace(name[start]))
        {
            start++;
        }
        while (end > start && IsJsWhiteSpace(name[end - 1]))
        {
            end--;
        }
        return name[start..end];
    }

    // 1-40 code points, each a letter or a digit (Unicode L and N), a space, "_" or "-".
    public static bool IsValid(string trimmed)
    {
        var length = 0;
        foreach (var rune in trimmed.EnumerateRunes())
        {
            if (++length > MaxLength || !(Rune.IsLetter(rune) || Rune.IsNumber(rune) || rune.Value is ' ' or '_' or '-'))
            {
                return false;
            }
        }
        return length > 0;
    }

    // Lower case, "ł" → "l", diacritics dropped, every run of other characters → one "-", no "-" at either end. Empty
    // for a name without a Latin letter or digit ("ß", "Привет"). JavaScript lowercases "İ" to "i" + U+0307, while .NET's
    // invariant lowercasing keeps it, hence the replacement first.
    public static string DirectoryOf(string trimmed)
    {
        var decomposed = trimmed.Replace("İ", "i̇").ToLowerInvariant().Replace('ł', 'l').Normalize(NormalizationForm.FormD);
        var letters = new StringBuilder(decomposed.Length);
        foreach (var rune in decomposed.EnumerateRunes())
        {
            if (Rune.GetUnicodeCategory(rune) is not (UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark
                or UnicodeCategory.EnclosingMark))
            {
                letters.Append(rune);
            }
        }
        return OtherCharacters().Replace(letters.ToString(), "-").Trim('-');
    }

    private static bool IsJsWhiteSpace(char c) => c == '﻿' || (char.IsWhiteSpace(c) && c != '\u0085');

    [GeneratedRegex("[^a-z0-9_-]+")]
    private static partial Regex OtherCharacters();
}
