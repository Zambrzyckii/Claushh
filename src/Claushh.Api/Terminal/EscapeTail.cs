// The escape sequence a terminal's output ends inside, if any (docs/ARCHITECTURE.md, "Backend" → "Terminal"). tmux cuts
// its output into %output lines wherever its read of the pane ended, also inside a sequence; Attach appends the
// unfinished one to its snapshot, so the next TerminalOutput completes it in the view. Fed and read only on the control
// client's reader.
using System.Text;

namespace Claushh.Api.Terminal;

public sealed class EscapeTail
{
    // An unfinished sequence longer than this (e.g. an image in a DCS string) is not kept.
    public const int MaxLength = 4096;

    // Text: the string of an OSC, DCS, SOS, PM or APC; TextEscape: an ESC inside it, perhaps the start of its ST.
    private enum State { Ground, Escape, Intermediate, Csi, Text, TextEscape }

    private readonly StringBuilder _open = new();
    private State _state;

    // The unfinished sequence at the end of everything fed so far; "" between sequences or when it is too long.
    public string Open => _open.Length > MaxLength ? "" : _open.ToString();

    // ECMA-48 in short: ESC starts a sequence; "[" makes it a CSI, which ends at a byte from @ to ~; "]", "P", "X", "^"
    // and "_" make it a string, which ends at BEL or ST (ESC \); bytes from space to / are intermediates, and the byte
    // after them ends the sequence; CAN and SUB cancel one. A control character inside a CSI is run by the terminal at
    // once, so it is not kept.
    public void Feed(ReadOnlySpan<char> text)
    {
        foreach (var c in text)
        {
            if (_state == State.TextEscape && c != '\\')
            {
                // The ESC ended the string and starts the next sequence.
                _open.Clear().Append('\e');
                _state = State.Escape;
            }
            if (c == '\e' && _state != State.Text)
            {
                _open.Clear();
                _state = State.Escape;
            }
            else if (c is '\x18' or '\x1a')
            {
                _state = State.Ground;
            }
            else
            {
                _state = _state switch
                {
                    State.Escape => c switch
                    {
                        '[' => State.Csi,
                        ']' or 'P' or 'X' or '^' or '_' => State.Text,
                        < ' ' => State.Escape,
                        <= '/' => State.Intermediate,
                        _ => State.Ground,
                    },
                    State.Intermediate => c <= '/' ? State.Intermediate : State.Ground,
                    State.Csi => c < '@' ? State.Csi : State.Ground,
                    State.Text => c switch { '\a' => State.Ground, '\e' => State.TextEscape, _ => State.Text },
                    _ => State.Ground,
                };
            }
            if (_state == State.Ground)
            {
                _open.Clear();
            }
            else if ((c >= ' ' || c == '\e' || _state == State.Text) && _open.Length <= MaxLength)
            {
                _open.Append(c);
            }
        }
    }
}
