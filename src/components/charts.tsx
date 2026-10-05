"use client";

import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Point = { minute: string; ok: number; clientErrors: number; serverErrors: number; p95: number };

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function TrafficChart({ data }: { data: Point[] }) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="#eef0f3" vertical={false} />
          <XAxis dataKey="minute" tickFormatter={time} tick={{ fontSize: 11, fill: "#6b7280" }} minTickGap={40} tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#6b7280" }} tickLine={false} axisLine={false} />
          <Tooltip labelFormatter={(value) => time(String(value))} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
          <Area type="monotone" dataKey="ok" name="2xx" stackId="1" stroke="#10b981" fill="#10b981" fillOpacity={0.25} />
          <Area type="monotone" dataKey="clientErrors" name="4xx" stackId="1" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.3} />
          <Area type="monotone" dataKey="serverErrors" name="5xx" stackId="1" stroke="#e11d48" fill="#e11d48" fillOpacity={0.4} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function LatencyChart({ data, objective }: { data: Point[]; objective: number }) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -10 }}>
          <CartesianGrid stroke="#eef0f3" vertical={false} />
          <XAxis dataKey="minute" tickFormatter={time} tick={{ fontSize: 11, fill: "#6b7280" }} minTickGap={40} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "#6b7280" }} tickLine={false} axisLine={false} unit="ms" domain={[0, (max: number) => Math.max(max, objective * 1.2)]} />
          <Tooltip labelFormatter={(value) => time(String(value))} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
          <Line type="monotone" dataKey={() => objective} name="objective" stroke="#e11d48" strokeDasharray="4 4" dot={false} strokeWidth={1} />
          <Line type="monotone" dataKey="p95" name="p95" stroke="#4f46e5" dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
