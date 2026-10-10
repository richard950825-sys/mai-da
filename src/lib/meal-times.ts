export type MealSlot = {
  key: string;
  date: string;
  label: string;
  start: string;
  end: string;
  period: 'breakfast' | 'regular' | 'other';
};
export function chinaTime(date: string, time: string) {
  return Date.parse(`${date}T${time}:00+08:00`);
}
export function reservationSlots(
  options: { date: string; reservationOptionText: string }[],
  now = Date.now(),
): MealSlot[] {
  return options.flatMap((option) => {
    const slots: MealSlot[] = [];
    const pattern =
      /([^，,（）()]+)[（(]\s*((?:[01]\d|2[0-3]):[0-5]\d)\s*至\s*((?:[01]\d|2[0-3]):[0-5]\d)\s*[)）]/g;
    for (const m of option.reservationOptionText.matchAll(pattern)) {
      const [, rawLabel, start, end] = m,
        label = rawLabel.trim();
      const period = /早餐/.test(label)
        ? 'breakfast'
        : /午餐|晚餐|夜市|宵夜|下午茶/.test(label)
          ? 'regular'
          : 'other';
      if (
        end < start ||
        !Number.isFinite(chinaTime(option.date, end)) ||
        chinaTime(option.date, end) <= now
      )
        continue;
      slots.push({
        key: `${option.date}|${label}|${start}`,
        date: option.date,
        label,
        start,
        end,
        period,
      });
    }
    return slots;
  });
}
export function validSlotTime(slot: MealSlot | undefined, time: string, now = Date.now()) {
  return (
    !!slot &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(time) &&
    time >= slot.start &&
    time <= slot.end &&
    chinaTime(slot.date, time) > now
  );
}
