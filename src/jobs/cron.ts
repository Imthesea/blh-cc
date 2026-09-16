/** cron 表达式解析与校验(五段式,零依赖)。 */

function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) return value % Number(field.slice(2)) === 0;
  if (field.includes(",")) {
    return field.split(",").some((part) => cronFieldMatches(part.trim(), value));
  }
  if (field.includes("-")) {
    const dash = field.indexOf("-");
    return Number(field.slice(0, dash)) <= value && value <= Number(field.slice(dash + 1));
  }
  return value === Number(field);
}

export function cronMatches(cronExpr: string, moment: Date): boolean {
  const trimmed = cronExpr.trim();
  const fields = trimmed === "" ? [] : trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const cronWeekday = moment.getDay(); // 周日=0…周六=6,与 cron 定义一致
  if (
    !(
      cronFieldMatches(minute, moment.getMinutes()) &&
      cronFieldMatches(hour, moment.getHours()) &&
      cronFieldMatches(month, moment.getMonth() + 1)
    )
  ) {
    return false;
  }
  const dayMatches = cronFieldMatches(day, moment.getDate());
  const weekdayMatches = cronFieldMatches(weekday, cronWeekday);
  if (day === "*" && weekday === "*") return true;
  if (day === "*") return weekdayMatches;
  if (weekday === "*") return dayMatches;
  return dayMatches || weekdayMatches;
}

function validateCronField(field: string, minimum: number, maximum: number): string | null {
  if (field === "*") return null;
  if (field.startsWith("*/")) {
    const step = field.slice(2);
    if (!/^\d+$/.test(step) || Number(step) <= 0) return `Invalid step: ${field}`;
    return null;
  }
  if (field.includes(",")) {
    for (const part of field.split(",")) {
      const error = validateCronField(part.trim(), minimum, maximum);
      if (error) return error;
    }
    return null;
  }
  if (field.includes("-")) {
    const dash = field.indexOf("-");
    const start = field.slice(0, dash);
    const end = field.slice(dash + 1);
    if (!/^\d+$/.test(start) || !/^\d+$/.test(end)) return `Invalid range: ${field}`;
    const startValue = Number(start);
    const endValue = Number(end);
    if (startValue > endValue) return `Range start is greater than end: ${field}`;
    if (startValue < minimum || endValue > maximum) {
      return `Range ${field} is outside [${minimum}-${maximum}]`;
    }
    return null;
  }
  if (!/^\d+$/.test(field)) return `Invalid field: ${field}`;
  const value = Number(field);
  if (value < minimum || value > maximum) return `Value ${value} is outside [${minimum}-${maximum}]`;
  return null;
}

export function validateCron(cronExpr: string): string | null {
  const trimmed = cronExpr.trim();
  const fields = trimmed === "" ? [] : trimmed.split(/\s+/);
  if (fields.length !== 5) return `Expected 5 fields, got ${fields.length}`;
  const fieldRules: Array<[string, number, number]> = [
    ["minute", 0, 59],
    ["hour", 0, 23],
    ["day-of-month", 1, 31],
    ["month", 1, 12],
    ["day-of-week", 0, 6],
  ];
  for (let i = 0; i < fields.length; i++) {
    const [name, minimum, maximum] = fieldRules[i] as [string, number, number];
    const error = validateCronField(fields[i] as string, minimum, maximum);
    if (error) return `${name}: ${error}`;
  }
  return null;
}
