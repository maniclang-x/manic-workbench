//! Engine smoke test: a neon frame with each primitive + a few verbs.
//! Renders the visual identity independently of the .manic language.
//!
//! Live:   cargo run --example smoke
//! Still:  cargo run --example smoke -- --still 2.0 --scale 1.5
//! CRT:    cargo run --example smoke -- --crt

use manic::prelude::*;

fn main() {
    let mut m = Movie::new("manic", 1280, 720);

    {
        let mut s = m.scene();
        s.circle("a", v(360.0, 360.0), 48.0).label("A");
        s.circle("b", v(920.0, 360.0), 48.0)
            .color(PANEL)
            .label("B")
            .hidden();
        s.arrow("e", v(408.0, 360.0), v(408.0, 360.0))
            .color(MAGENTA)
            .hidden();
        s.rect("box", v(640.0, 520.0), 120.0, 70.0)
            .outline_color(LIME)
            .hidden();
        s.text("cap", v(640.0, 640.0), "")
            .size(24.0)
            .color(DIM)
            .hidden();
        s.text("title", v(640.0, 200.0), "NEON TERMINAL")
            .display()
            .size(44.0)
            .color(CYAN)
            .hidden();
    }

    m.play(act().fade_in("title").dur(0.5));
    m.play(act().set_text("cap", "primitives, glowing, on the void"));
    m.play(act().fade_in("b").dur(0.4));
    m.play(par![
        act().fade_in("e").dur(0.15),
        act()
            .grow_to("e", v(872.0, 360.0))
            .dur(0.6)
            .ease(InOutCubic),
    ]);
    m.play(seq![
        act().highlight("b", MAGENTA),
        act().pulse("b"),
        wait(0.4),
    ]);
    m.play(act().fade_in("box").dur(0.4));
    m.play(act().move_to("a", v(360.0, 250.0)).dur(0.6).ease(OutBack));
    m.wait(1.0);

    manic::run(m);
}
