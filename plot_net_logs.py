#!/usr/bin/env python3
"""
Interactive Dash dashboard for net_monitor.csv

Features:
- Real-time dashboard with key metrics at the top
- Hover tooltips on stability points (with ping, jitter, DL/UL, grade)
- Colors stability points by health_grade (A/B/C/D/F), or derives grade if missing
- Vertical red markers for "very bad" runs (stability_score < 40)
- --provider <name> to filter rows

Usage:
  python plot_net_logs.py logs/net_monitor.csv
  python plot_net_logs.py logs/net_monitor.csv --provider "MyISP"
"""

import csv
import sys
from pathlib import Path
from datetime import datetime
import argparse

from dash import Dash, dcc, html
import plotly.graph_objects as go
from plotly.subplots import make_subplots


# -------------------------------------------------------------
# Helpers
# -------------------------------------------------------------

def parse_timestamp(ts: str):
    """Parse ISO timestamp into datetime and convert to local time."""
    if not ts:
        return None
    ts = ts.strip()
    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(ts)
        # Convert to local timezone
        if dt.tzinfo is not None:
            dt = dt.astimezone()
        return dt
    except Exception:
        return None


def maybe_float(row, key):
    v = row.get(key, "")
    try:
        return float(v) if v != "" else None
    except ValueError:
        return None


def derive_grade_from_stability(score):
    """Fallback grade if CSV has no health_grade column."""
    if score is None:
        return None
    if score >= 90:
        return "A"
    if score >= 75:
        return "B"
    if score >= 60:
        return "C"
    if score >= 40:
        return "D"
    return "F"


# -------------------------------------------------------------
# Main
# -------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Plot network monitor results (Plotly, dark mode).")
    parser.add_argument("csvfile", help="Path to net_monitor.csv")
    parser.add_argument(
        "--provider",
        help="Only plot rows that match this provider name exactly",
        default=None,
    )

    args = parser.parse_args()
    csv_path = Path(args.csvfile)

    if not csv_path.exists():
        print(f"CSV file not found: {csv_path}")
        sys.exit(1)

    # --- Read CSV ---
    rows = []
    with csv_path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        for row in reader:
            rows.append(row)

    # --- Filter by provider if requested ---
    if args.provider:
        if "provider" not in fieldnames:
            print("⚠️  CSV has no 'provider' column — cannot filter.")
        else:
            before = len(rows)
            rows = [r for r in rows if (r.get("provider") or "") == args.provider]
            after = len(rows)
            if after == 0:
                print(f"No rows found for provider '{args.provider}'. Exiting.")
                sys.exit(0)
            print(f"Filtered by provider: {before} → {after} rows")

    if not rows:
        print("No rows in CSV.")
        sys.exit(1)

    # --- Extract fields we care about ---
    timestamps = []
    cf_ping = []
    cf_jitter = []
    download_mbps = []
    upload_mbps = []
    stability_score = []
    dns_cf = []
    dns_gg = []
    trace_score = []
    health_grade = []
    
    # Rolling averages
    cf_avg_1h = []
    cf_avg_24h = []
    cf_jitter_1h = []
    cf_jitter_24h = []
    cf_loss_1h = []
    cf_loss_24h = []
    dl_1h = []
    dl_24h = []
    ul_1h = []
    ul_24h = []
    stab_1h = []
    stab_24h = []

    has_trace_score = "trace_score" in fieldnames
    has_health_grade = "health_grade" in fieldnames

    for row in rows:
        ts = parse_timestamp(row.get("timestamp", ""))
        if ts is None:
            continue

        # Only consider online rows; offline ones usually have empty metrics
        online_raw = (row.get("online") or "").strip().lower()
        is_online = online_raw in ("1", "true", "yes")
        if not is_online:
            continue

        timestamps.append(ts)

        cf_ping.append(maybe_float(row, "cloudflare_avg_ms"))
        cf_jitter.append(maybe_float(row, "cloudflare_jitter_ms"))

        download_mbps.append(maybe_float(row, "speed_download_mbps"))
        upload_mbps.append(maybe_float(row, "speed_upload_mbps"))

        stab = maybe_float(row, "stability_score")
        stability_score.append(stab)

        dns_cf.append(maybe_float(row, "dns_cloudflare_ms"))
        dns_gg.append(maybe_float(row, "dns_google_ms"))

        if has_trace_score:
            trace_score.append(maybe_float(row, "trace_score"))
        else:
            trace_score.append(None)

        if has_health_grade:
            g = (row.get("health_grade") or "").strip().upper()
            health_grade.append(g if g else derive_grade_from_stability(stab))
        else:
            health_grade.append(derive_grade_from_stability(stab))
        
        # Rolling averages
        cf_avg_1h.append(maybe_float(row, "cloudflare_avg_1h"))
        cf_avg_24h.append(maybe_float(row, "cloudflare_avg_24h"))
        cf_jitter_1h.append(maybe_float(row, "cloudflare_jitter_1h"))
        cf_jitter_24h.append(maybe_float(row, "cloudflare_jitter_24h"))
        cf_loss_1h.append(maybe_float(row, "cloudflare_loss_1h"))
        cf_loss_24h.append(maybe_float(row, "cloudflare_loss_24h"))
        dl_1h.append(maybe_float(row, "download_1h"))
        dl_24h.append(maybe_float(row, "download_24h"))
        ul_1h.append(maybe_float(row, "upload_1h"))
        ul_24h.append(maybe_float(row, "upload_24h"))
        stab_1h.append(maybe_float(row, "stability_1h"))
        stab_24h.append(maybe_float(row, "stability_24h"))

    if not timestamps:
        print("No valid rows after filtering/online check.")
        sys.exit(1)

    # -------------------------------------------------------------
    # Color mapping & "bad" markers
    # -------------------------------------------------------------
    grade_colors = {
        "A": "#00d98b",
        "B": "#9acd32",
        "C": "#ffb347",
        "D": "#ff5c5c",
        "F": "#c00000",
    }

    bad_ts = [
        ts
        for ts, s in zip(timestamps, stability_score)
        if s is not None and s < 40
    ]

    # -------------------------------------------------------------
    # Build Plotly figure
    # -------------------------------------------------------------
    fig = make_subplots(
        rows=6,
        cols=1,
        shared_xaxes=True,
        subplot_titles=[
            "Latency & DNS",
            "Download / Upload Speeds",
            "Stability & Trace Score",
            "Latency Rolling Averages (1h / 24h)",
            "Speed Rolling Averages (1h / 24h)",
            "Stability Rolling Averages (1h / 24h)",
        ],
        vertical_spacing=0.04,
        row_heights=[0.17, 0.17, 0.17, 0.16, 0.16, 0.17],
    )

    # --- 1) Latency + DNS ---
    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=cf_ping,
            mode="lines+markers",
            name="Cloudflare Ping",
            line=dict(width=2, color="#00d4ff"),
            marker=dict(size=5, opacity=0.7),
            connectgaps=True,
            hovertemplate="Ping: %{y:.1f} ms<extra></extra>",
        ),
        row=1,
        col=1,
    )

    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=cf_jitter,
            mode="lines",
            name="Jitter",
            line=dict(width=1.5, dash="dot", color="#ffaa00"),
            connectgaps=True,
            hovertemplate="Jitter: %{y:.1f} ms<extra></extra>",
        ),
        row=1,
        col=1,
    )

    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=dns_cf,
            mode="lines",
            name="DNS Cloudflare",
            line=dict(width=1.5, dash="dash", color="#9966ff"),
            connectgaps=True,
            hovertemplate="DNS CF: %{y:.1f} ms<extra></extra>",
        ),
        row=1,
        col=1,
    )

    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=dns_gg,
            mode="lines",
            name="DNS Google",
            line=dict(width=1.5, dash="dashdot", color="#ff66cc"),
            connectgaps=True,
            hovertemplate="DNS Google: %{y:.1f} ms<extra></extra>",
        ),
        row=1,
        col=1,
    )

    # --- 2) Download / Upload Speeds ---
    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=download_mbps,
            mode="lines+markers",
            name="Download",
            line=dict(width=2.5, color="#00ff88"),
            marker=dict(size=5, opacity=0.7),
            connectgaps=True,
            hovertemplate="DL: %{y:.1f} Mbps<extra></extra>",
        ),
        row=2,
        col=1,
    )

    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=upload_mbps,
            mode="lines+markers",
            name="Upload",
            line=dict(width=2.5, color="#ff88ff"),
            marker=dict(size=5, opacity=0.7),
            connectgaps=True,
            hovertemplate="UL: %{y:.1f} Mbps<extra></extra>",
        ),
        row=2,
        col=1,
    )

    # --- 3) Stability + trace line ---
    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=stability_score,
            mode="lines",
            name="Stability",
            line=dict(width=2, color="rgba(200, 200, 255, 0.6)"),
            connectgaps=True,
            hovertemplate="Stability: %{y:.1f}<extra></extra>",
        ),
        row=3,
        col=1,
    )

    if any(v is not None for v in trace_score):
        trace_clean = [v if v is not None else None for v in trace_score]
        fig.add_trace(
            go.Scatter(
                x=timestamps,
                y=trace_clean,
                mode="lines",
                name="Trace Score",
                line=dict(width=1.5, dash="dot", color="#cccccc"),
                connectgaps=True,
                hovertemplate="Trace: %{y:.1f}<extra></extra>",
            ),
            row=3,
            col=1,
        )

    # --- Stability points colored by grade with rich hover ---
    # Pre-compute arrays for point hover
    custom_ping = cf_ping
    custom_jitter = cf_jitter
    custom_dl = download_mbps
    custom_ul = upload_mbps

    for grade, color in grade_colors.items():
        xs = []
        ys = []
        customdata = []

        for ts, s, g, p, j, dl, ul in zip(
            timestamps,
            stability_score,
            health_grade,
            custom_ping,
            custom_jitter,
            custom_dl,
            custom_ul,
        ):
            if s is None:
                continue
            # Only include points that match this grade
            if (g or grade) != grade:
                continue

            xs.append(ts)
            ys.append(s)
            customdata.append([g or grade, p, j, dl, ul])

        if not xs:
            continue

        fig.add_trace(
            go.Scatter(
                x=xs,
                y=ys,
                mode="markers",
                name=f"Grade {grade}",
                marker=dict(
                    size=8,
                    color=color,
                    line=dict(width=1, color="rgba(255,255,255,0.3)"),
                ),
                customdata=customdata,
                hovertemplate=(
                    "Stability: %{y:.1f}"
                    "<br>Grade: %{customdata[0]}"
                    "<br>Ping: %{customdata[1]:.1f} ms"
                    "<br>Jitter: %{customdata[2]:.1f} ms"
                    "<br>DL: %{customdata[3]:.1f} Mbps"
                    "<br>UL: %{customdata[4]:.1f} Mbps"
                    "<extra></extra>"
                ),
            ),
            row=3,
            col=1,
        )

    # --- 4) Latency Rolling Averages ---
    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=cf_avg_1h,
            mode="lines",
            name="Ping avg 1h",
            line=dict(width=2, color="#00d4ff"),
            connectgaps=True,
            hovertemplate="Ping 1h: %{y:.1f} ms<extra></extra>",
        ),
        row=4,
        col=1,
    )

    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=cf_avg_24h,
            mode="lines",
            name="Ping avg 24h",
            line=dict(width=2, color="#0088ff"),
            connectgaps=True,
            hovertemplate="Ping 24h: %{y:.1f} ms<extra></extra>",
        ),
        row=4,
        col=1,
    )

    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=cf_jitter_1h,
            mode="lines",
            name="Jitter 1h",
            line=dict(width=1.5, dash="dot", color="#ffaa00"),
            connectgaps=True,
            hovertemplate="Jitter 1h: %{y:.1f} ms<extra></extra>",
        ),
        row=4,
        col=1,
    )

    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=cf_jitter_24h,
            mode="lines",
            name="Jitter 24h",
            line=dict(width=1.5, dash="dot", color="#ff6600"),
            connectgaps=True,
            hovertemplate="Jitter 24h: %{y:.1f} ms<extra></extra>",
        ),
        row=4,
        col=1,
    )

    # --- 5) Speed Rolling Averages ---
    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=dl_1h,
            mode="lines",
            name="DL avg 1h",
            line=dict(width=2, color="#00ff88"),
            connectgaps=True,
            hovertemplate="DL 1h: %{y:.1f} Mbps<extra></extra>",
        ),
        row=5,
        col=1,
    )

    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=dl_24h,
            mode="lines",
            name="DL avg 24h",
            line=dict(width=2, color="#00aa66"),
            connectgaps=True,
            hovertemplate="DL 24h: %{y:.1f} Mbps<extra></extra>",
        ),
        row=5,
        col=1,
    )

    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=ul_1h,
            mode="lines",
            name="UL avg 1h",
            line=dict(width=1.5, dash="dash", color="#ff88ff"),
            connectgaps=True,
            hovertemplate="UL 1h: %{y:.1f} Mbps<extra></extra>",
        ),
        row=5,
        col=1,
    )

    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=ul_24h,
            mode="lines",
            name="UL avg 24h",
            line=dict(width=1.5, dash="dash", color="#cc66cc"),
            connectgaps=True,
            hovertemplate="UL 24h: %{y:.1f} Mbps<extra></extra>",
        ),
        row=5,
        col=1,
    )

    # --- 6) Stability Rolling Averages ---
    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=stab_1h,
            mode="lines",
            name="Stability 1h",
            line=dict(width=2, color="#88ccff"),
            connectgaps=True,
            hovertemplate="Stability 1h: %{y:.1f}<extra></extra>",
        ),
        row=6,
        col=1,
    )

    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=stab_24h,
            mode="lines",
            name="Stability 24h",
            line=dict(width=2, color="#5588ff"),
            connectgaps=True,
            hovertemplate="Stability 24h: %{y:.1f}<extra></extra>",
        ),
        row=6,
        col=1,
    )

    # --- Vertical markers for bad stability ---
    shapes = []
    for ts in bad_ts:
        shapes.append(
            dict(
                type="line",
                xref="x",
                yref="paper",
                x0=ts,
                x1=ts,
                y0=0,
                y1=1,
                line=dict(color="red", width=1, dash="dot"),
                opacity=0.18,
            )
        )

    # --- Layout / dark mode styling ---
    fig.update_layout(
        
        hovermode="x unified",
        hoverlabel=dict(
            bgcolor="rgba(255, 255, 255, 0.95)",
            font=dict(size=13, family="monospace"),
            bordercolor="rgba(0, 0, 0, 0.3)",
        ),
        shapes=shapes,
        margin=dict(l=80, r=40, t=120, b=60, pad=0),
        height=1600,
        plot_bgcolor="white",
        paper_bgcolor="white",
        font=dict(size=12, color="#333333"),
        legend=dict(
            bgcolor="rgba(255, 255, 255, 0.9)",
            bordercolor="rgba(0, 0, 0, 0.2)",
            borderwidth=1,
            orientation="h",
            yanchor="bottom",
            y=1.02,
            xanchor="left",
            x=0,
            font=dict(size=11),
        ),
    )

    # Update all y-axes for better readability
    fig.update_yaxes(
        title_text="Latency (ms)",
        title_font=dict(size=13, color="#666666"),
        gridcolor="rgba(200, 200, 200, 0.5)",
        zeroline=True,
        zerolinecolor="rgba(150, 150, 150, 0.5)",
        row=1,
        col=1,
    )
    fig.update_yaxes(
        title_text="Speed (Mbps)",
        title_font=dict(size=13, color="#666666"),
        gridcolor="rgba(200, 200, 200, 0.5)",
        zeroline=True,
        zerolinecolor="rgba(150, 150, 150, 0.5)",
        row=2,
        col=1,
    )
    fig.update_yaxes(
        title_text="Score (0–100)",
        title_font=dict(size=13, color="#666666"),
        range=[0, 100],
        gridcolor="rgba(200, 200, 200, 0.5)",
        zeroline=False,
        row=3,
        col=1,
    )
    fig.update_yaxes(
        title_text="Latency (ms)",
        title_font=dict(size=13, color="#666666"),
        gridcolor="rgba(200, 200, 200, 0.5)",
        zeroline=True,
        zerolinecolor="rgba(150, 150, 150, 0.5)",
        row=4,
        col=1,
    )
    fig.update_yaxes(
        title_text="Speed (Mbps)",
        title_font=dict(size=13, color="#666666"),
        gridcolor="rgba(200, 200, 200, 0.5)",
        zeroline=True,
        zerolinecolor="rgba(150, 150, 150, 0.5)",
        row=5,
        col=1,
    )
    fig.update_yaxes(
        title_text="Score (0–100)",
        title_font=dict(size=13, color="#666666"),
        range=[0, 100],
        gridcolor="rgba(200, 200, 200, 0.5)",
        zeroline=False,
        row=6,
        col=1,
    )

    # Update all x-axes
    for i in range(1, 7):
        fig.update_xaxes(
            gridcolor="rgba(200, 200, 200, 0.3)",
            showgrid=True,
            row=i,
            col=1,
        )

    fig.update_xaxes(
        title_text="Time",
        title_font=dict(size=13, color="#666666"),
        row=6,
        col=1,
    )
    
    # --- Get latest rolling averages for dashboard ---
    latest_values = {}
    if dl_24h and dl_24h[-1] is not None:
        latest_values["download_24h"] = f"{dl_24h[-1]:.1f}"
    else:
        latest_values["download_24h"] = "N/A"
    
    if ul_24h and ul_24h[-1] is not None:
        latest_values["upload_24h"] = f"{ul_24h[-1]:.1f}"
    else:
        latest_values["upload_24h"] = "N/A"
    
    if cf_avg_24h and cf_avg_24h[-1] is not None:
        latest_values["ping_24h"] = f"{cf_avg_24h[-1]:.1f}"
    else:
        latest_values["ping_24h"] = "N/A"
    
    if cf_jitter_24h and cf_jitter_24h[-1] is not None:
        latest_values["jitter_24h"] = f"{cf_jitter_24h[-1]:.1f}"
    else:
        latest_values["jitter_24h"] = "N/A"
    
    if stab_24h and stab_24h[-1] is not None:
        latest_values["stability_24h"] = f"{stab_24h[-1]:.1f}"
    else:
        latest_values["stability_24h"] = "N/A"
    
    # --- Build Dash app ---
    app = Dash(__name__)
    
    # Dashboard metrics cards
    dashboard_cards = [
        html.Div([
            html.Div("Avg Download (24h)", style={
                "fontSize": "12px", 
                "color": "#666", 
                "textTransform": "uppercase", 
                "letterSpacing": "0.5px", 
                "marginBottom": "5px"
            }),
            html.Div(latest_values["download_24h"], style={
                "fontSize": "28px", 
                "fontWeight": "bold", 
                "color": "#00d4ff"
            }),
            html.Div("Mbps", style={
                "fontSize": "11px", 
                "color": "#999", 
                "marginTop": "2px"
            })
        ], style={
            "background": "white", 
            "padding": "15px 25px", 
            "borderRadius": "8px", 
            "boxShadow": "0 2px 4px rgba(0,0,0,0.1)", 
            "minWidth": "140px", 
            "textAlign": "center"
        }),
        
        html.Div([
            html.Div("Avg Upload (24h)", style={
                "fontSize": "12px", 
                "color": "#666", 
                "textTransform": "uppercase", 
                "letterSpacing": "0.5px", 
                "marginBottom": "5px"
            }),
            html.Div(latest_values["upload_24h"], style={
                "fontSize": "28px", 
                "fontWeight": "bold", 
                "color": "#00d98b"
            }),
            html.Div("Mbps", style={
                "fontSize": "11px", 
                "color": "#999", 
                "marginTop": "2px"
            })
        ], style={
            "background": "white", 
            "padding": "15px 25px", 
            "borderRadius": "8px", 
            "boxShadow": "0 2px 4px rgba(0,0,0,0.1)", 
            "minWidth": "140px", 
            "textAlign": "center"
        }),
        
        html.Div([
            html.Div("Avg Ping (24h)", style={
                "fontSize": "12px", 
                "color": "#666", 
                "textTransform": "uppercase", 
                "letterSpacing": "0.5px", 
                "marginBottom": "5px"
            }),
            html.Div(latest_values["ping_24h"], style={
                "fontSize": "28px", 
                "fontWeight": "bold", 
                "color": "#ff6b6b"
            }),
            html.Div("ms", style={
                "fontSize": "11px", 
                "color": "#999", 
                "marginTop": "2px"
            })
        ], style={
            "background": "white", 
            "padding": "15px 25px", 
            "borderRadius": "8px", 
            "boxShadow": "0 2px 4px rgba(0,0,0,0.1)", 
            "minWidth": "140px", 
            "textAlign": "center"
        }),
        
        html.Div([
            html.Div("Avg Jitter (24h)", style={
                "fontSize": "12px", 
                "color": "#666", 
                "textTransform": "uppercase", 
                "letterSpacing": "0.5px", 
                "marginBottom": "5px"
            }),
            html.Div(latest_values["jitter_24h"], style={
                "fontSize": "28px", 
                "fontWeight": "bold", 
                "color": "#ffaa00"
            }),
            html.Div("ms", style={
                "fontSize": "11px", 
                "color": "#999", 
                "marginTop": "2px"
            })
        ], style={
            "background": "white", 
            "padding": "15px 25px", 
            "borderRadius": "8px", 
            "boxShadow": "0 2px 4px rgba(0,0,0,0.1)", 
            "minWidth": "140px", 
            "textAlign": "center"
        }),
        
        html.Div([
            html.Div("Avg Stability (24h)", style={
                "fontSize": "12px", 
                "color": "#666", 
                "textTransform": "uppercase", 
                "letterSpacing": "0.5px", 
                "marginBottom": "5px"
            }),
            html.Div(latest_values["stability_24h"], style={
                "fontSize": "28px", 
                "fontWeight": "bold", 
                "color": "#9966ff"
            }),
            html.Div("score", style={
                "fontSize": "11px", 
                "color": "#999", 
                "marginTop": "2px"
            })
        ], style={
            "background": "white", 
            "padding": "15px 25px", 
            "borderRadius": "8px", 
            "boxShadow": "0 2px 4px rgba(0,0,0,0.1)", 
            "minWidth": "140px", 
            "textAlign": "center"
        })
    ]
    
    # App layout
    app.layout = html.Div([
        html.Div(dashboard_cards, style={
            "display": "flex", 
            "gap": "20px", 
            "padding": "20px", 
            "background": "#f5f5f5", 
            "borderBottom": "2px solid #ddd", 
            "flexWrap": "wrap", 
            "justifyContent": "center",
            "position": "sticky",
            "top": "0",
            "zIndex": "1000"
        }),
        dcc.Graph(
            figure=fig,
            style={"height": "3000px", "width": "100%"}
        )
    ], style={
        "margin": "0", 
        "padding": "0", 
        "fontFamily": "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    })
    
    # Inject custom CSS to remove body margin
    app.index_string = '''
    <!DOCTYPE html>
    <html>
        <head>
            {%metas%}
            <title>{%title%}</title>
            {%favicon%}
            {%css%}
            <style>
                body {
                    margin: 0 !important;
                    padding: 0 !important;
                }
            </style>
        </head>
        <body>
            {%app_entry%}
            <footer>
                {%config%}
                {%scripts%}
                {%renderer%}
            </footer>
        </body>
    </html>
    '''
    
    print("✓ Starting Dash server on http://localhost:8050")
    
    # Open browser automatically
    import webbrowser
    from threading import Timer
    Timer(1.5, lambda: webbrowser.open("http://localhost:8050")).start()
    
    app.run(debug=False, port=8050)
    
if __name__ == "__main__":
    main()
