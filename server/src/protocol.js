import { z } from "zod";

export const LEVELS = ["low", "moderate", "high", "extreme"];
export const LEVEL_LABEL = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
  extreme: "Extreme",
  unknown: "Unknown — data needed",
};
export const INTENSITY_LABEL = {
  light: "light",
  moderate: "moderate",
  heavy: "heavy",
  very_heavy: "very heavy",
};
export const CLOTHING_LABEL = {
  standard: "standard work clothes",
  coveralls: "cloth coveralls",
  double_layer: "double-layer clothing",
  vapour_barrier: "vapour-barrier suit",
};
export const REQUIRED_CONTROLS = [
  "onsite_measurement",
  "provide_water",
  "provide_shade",
  "cool_rest_area",
  "acclimatization_plan",
  "stop_work_review",
  "manual_assessment",
  "check_on_worker",
  "fix_barrier",
];

const lang = z.object({
  en: z.string().min(1).max(400),
  hi: z.string().max(400).optional(),
  ar: z.string().max(400).optional(),
});
const band = z
  .object({
    moderate: z.number().min(0).max(70),
    high: z.number().min(0).max(70),
    extreme: z.number().min(0).max(70),
  })
  .refine((value) => value.moderate < value.high && value.high < value.extreme, {
    message: "Bands must increase: moderate < high < extreme",
  });
const byIntensity = z.object({
  light: band,
  moderate: band,
  heavy: band,
  very_heavy: band,
});
const levelRef = z.enum(["low", "moderate", "high", "extreme"]);
const controlSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{2,40}$/),
  title: z.string().min(3).max(120),
  instructions: z.string().min(3).max(600),
  worker: lang.optional(),
  assignedRole: z.enum(["supervisor", "safety_lead"]),
  priority: z.enum(["routine", "high", "urgent"]),
  ackMinutes: z.number().int().min(1).max(240),
  dueMinutes: z.number().int().min(1).max(1440),
});

export const protocolConfigSchema = z
  .object({
    exampleOnly: z.boolean(),
    source: z.string().max(400),
    freshnessMinutes: z.object({
      forecast: z.number().int().min(5).max(360),
      current: z.number().int().min(5).max(240),
      onsite_wbgt: z.number().int().min(5).max(120),
      manual: z.number().int().min(5).max(120),
    }),
    clothingAdjustmentC: z.object({
      standard: z.number().min(0).max(15),
      coveralls: z.number().min(0).max(15),
      double_layer: z.number().min(0).max(15),
      vapour_barrier: z.number().min(0).max(15),
    }),
    thresholds: z.object({
      wbgt: z.object({ acclimatized: byIntensity, unacclimatized: byIntensity }),
      heatIndex: z.object({ acclimatized: byIntensity, unacclimatized: byIntensity }),
    }),
    levels: z.object({
      low: z.array(z.string()),
      moderate: z.array(z.string()),
      high: z.array(z.string()),
      extreme: z.array(z.string()),
      unknown: z.array(z.string()),
    }),
    requireOnsiteMeasurementAtOrAbove: levelRef,
    humanReviewAtOrAbove: levelRef,
    escalation: z.object({ level2AfterMinutes: z.number().int().min(5).max(480) }),
    workerMessages: z.object({
      low: lang,
      moderate: lang,
      high: lang,
      extreme: lang,
      unknown: lang,
    }),
    controls: z.array(controlSchema).min(1),
    translationNote: z.string().max(300).optional(),
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.controls.map((control) => control.id));
    for (const id of REQUIRED_CONTROLS) {
      if (!ids.has(id)) {
        ctx.addIssue({ code: "custom", message: `Control "${id}" is required by the system` });
      }
    }
    for (const [level, refs] of Object.entries(value.levels)) {
      for (const id of refs) {
        if (!ids.has(id)) {
          ctx.addIssue({ code: "custom", message: `Level ${level} references unknown control "${id}"` });
        }
      }
    }
    const stop = value.controls.find((control) => control.id === "stop_work_review");
    if (stop && stop.assignedRole !== "safety_lead") {
      ctx.addIssue({ code: "custom", message: "Stop-work review must be assigned to a Safety Lead" });
    }
  });

export function validateProtocol(config) {
  const parsed = protocolConfigSchema.safeParse(config);
  if (!parsed.success) {
    const message = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message };
  }
  return { ok: true, data: parsed.data };
}

function shift(bandValue, by) {
  return {
    moderate: bandValue.moderate - by,
    high: bandValue.high - by,
    extreme: bandValue.extreme - by,
  };
}

function mapBands(bands, by) {
  return Object.fromEntries(Object.entries(bands).map(([key, value]) => [key, shift(value, by)]));
}

const wbgtAccl = {
  light: { moderate: 29, high: 31, extreme: 33 },
  moderate: { moderate: 27, high: 29, extreme: 31 },
  heavy: { moderate: 25.5, high: 27.5, extreme: 29.5 },
  very_heavy: { moderate: 24.5, high: 26.5, extreme: 28.5 },
};
const hiAccl = {
  light: { moderate: 32, high: 39, extreme: 46 },
  moderate: { moderate: 30, high: 36, extreme: 43 },
  heavy: { moderate: 28, high: 34, extreme: 40 },
  very_heavy: { moderate: 27, high: 32, extreme: 38 },
};

const control = (fields) => fields;

export const DEFAULT_PROTOCOL = {
  exampleOnly: true,
  source:
    "EXAMPLE configuration for demonstration. Structure follows NIOSH 2016-106 concepts (WBGT, workload, clothing, acclimatization). Values are illustrative and must be replaced by the organization's approved protocol.",
  freshnessMinutes: { forecast: 90, current: 75, onsite_wbgt: 30, manual: 30 },
  clothingAdjustmentC: { standard: 0, coveralls: 0, double_layer: 3, vapour_barrier: 11 },
  thresholds: {
    wbgt: { acclimatized: wbgtAccl, unacclimatized: mapBands(wbgtAccl, 2.5) },
    heatIndex: { acclimatized: hiAccl, unacclimatized: mapBands(hiAccl, 2) },
  },
  levels: {
    low: [],
    moderate: ["hydration_reminder", "work_rest_schedule", "buddy_checks"],
    high: ["hydration_reminder", "work_rest_schedule", "buddy_checks", "reschedule_heavy"],
    extreme: ["hydration_reminder", "work_rest_schedule", "buddy_checks", "reschedule_heavy"],
    unknown: ["manual_assessment", "onsite_measurement"],
  },
  requireOnsiteMeasurementAtOrAbove: "high",
  humanReviewAtOrAbove: "extreme",
  escalation: { level2AfterMinutes: 30 },
  translationNote: "Hindi and Arabic text is a draft and must be reviewed by native speakers before use.",
  workerMessages: {
    low: {
      en: "Normal precautions. Keep drinking water and tell your supervisor if you feel unwell.",
      hi: "सामान्य सावधानियाँ। पानी पीते रहें और तबीयत ठीक न लगे तो सुपरवाइज़र को बताएँ।",
      ar: "احتياطات عادية. استمر في شرب الماء وأبلغ المشرف إذا شعرت بتوعك.",
    },
    moderate: {
      en: "Heat risk is moderate. Follow the rest schedule and drink water regularly.",
      hi: "गर्मी का जोखिम मध्यम है। आराम के समय का पालन करें और नियमित रूप से पानी पिएँ।",
      ar: "خطر الحرارة متوسط. التزم بجدول الراحة واشرب الماء بانتظام.",
    },
    high: {
      en: "Heat risk is high. Extra rest breaks are in place and heavy work may be moved.",
      hi: "गर्मी का जोखिम अधिक है। अतिरिक्त आराम दिया जा रहा है और भारी काम का समय बदल सकता है।",
      ar: "خطر الحرارة مرتفع. توجد فترات راحة إضافية وقد يتم نقل الأعمال الشاقة.",
    },
    extreme: {
      en: "Heat risk is extreme. Work may stop. Follow your supervisor's instructions now.",
      hi: "गर्मी का जोखिम बहुत अधिक है। काम रुक सकता है। अभी सुपरवाइज़र के निर्देशों का पालन करें।",
      ar: "خطر الحرارة شديد جدًا. قد يتوقف العمل. اتبع تعليمات المشرف الآن.",
    },
    unknown: {
      en: "Conditions are being checked. Follow your site's heat procedure and drink water regularly.",
      hi: "स्थितियों की जाँच हो रही है। साइट की गर्मी प्रक्रिया का पालन करें और नियमित रूप से पानी पिएँ।",
      ar: "يجري التحقق من الظروف. اتبع إجراءات الحرارة في الموقع واشرب الماء بانتظام.",
    },
  },
  controls: [
    control({
      id: "hydration_reminder",
      title: "Remind crew to drink water regularly",
      instructions:
        "Brief the crew to drink about one cup of cool water every 15–20 minutes during moderate work, even if not thirsty. Check that cups and water are at hand.",
      worker: {
        en: "Drink a cup of water every 15–20 minutes, even if you are not thirsty.",
        hi: "प्यास न लगे तब भी हर 15–20 मिनट में एक कप पानी पिएँ।",
        ar: "اشرب كوبًا من الماء كل 15–20 دقيقة حتى لو لم تشعر بالعطش.",
      },
      assignedRole: "supervisor",
      priority: "routine",
      ackMinutes: 20,
      dueMinutes: 45,
    }),
    control({
      id: "work_rest_schedule",
      title: "Apply the work-rest schedule for this risk level",
      instructions:
        "Apply the work-rest cycle defined in the approved protocol for this risk level and workload. Rest in shade or a cool area.",
      worker: {
        en: "Take your scheduled rest breaks in the shade or a cool area.",
        hi: "अपने तय आराम के समय छाया या ठंडी जगह में आराम करें।",
        ar: "خذ فترات الراحة المحددة في الظل أو في مكان بارد.",
      },
      assignedRole: "supervisor",
      priority: "high",
      ackMinutes: 15,
      dueMinutes: 30,
    }),
    control({
      id: "buddy_checks",
      title: "Set up buddy checks",
      instructions:
        "Pair workers to watch each other for early signs of heat illness. Remind everyone how to report and where first aid is.",
      worker: {
        en: "Watch your co-workers. Report dizziness, confusion or unusual tiredness to your supervisor at once.",
        hi: "अपने साथियों पर ध्यान दें। चक्कर, भ्रम या असामान्य थकान दिखे तो तुरंत सुपरवाइज़र को बताएँ।",
        ar: "راقب زملاءك. أبلغ المشرف فورًا عن أي دوخة أو ارتباك أو تعب غير عادي.",
      },
      assignedRole: "supervisor",
      priority: "routine",
      ackMinutes: 20,
      dueMinutes: 45,
    }),
    control({
      id: "reschedule_heavy",
      title: "Move heavy tasks to cooler hours",
      instructions:
        "Reschedule heavy or very heavy tasks to cooler periods, or rotate workers to reduce time in the heat.",
      worker: {
        en: "Heavy tasks may move to cooler hours — follow your supervisor's updated schedule.",
        hi: "भारी काम ठंडे समय में किए जा सकते हैं — सुपरवाइज़र के नए समय का पालन करें।",
        ar: "قد يتم نقل المهام الشاقة إلى ساعات أبرد — اتبع الجدول المحدث من المشرف.",
      },
      assignedRole: "supervisor",
      priority: "high",
      ackMinutes: 15,
      dueMinutes: 60,
    }),
    control({
      id: "onsite_measurement",
      title: "Take an on-site WBGT measurement",
      instructions:
        "Measure WBGT at the work area with a calibrated instrument, in comparable sun and wind exposure, and record it in HeatShield Shift. Remote data is only an estimate.",
      assignedRole: "supervisor",
      priority: "high",
      ackMinutes: 15,
      dueMinutes: 30,
    }),
    control({
      id: "manual_assessment",
      title: "Carry out the site's manual heat assessment",
      instructions:
        "Automatic assessment is not possible because data is missing or stale. Apply the site's manual heat procedure now and record the outcome.",
      assignedRole: "supervisor",
      priority: "urgent",
      ackMinutes: 10,
      dueMinutes: 30,
    }),
    control({
      id: "provide_water",
      title: "Provide cool drinking water at the work area",
      instructions:
        "The site record shows no drinking water at the work area. Provide cool potable water and cups before work continues.",
      worker: {
        en: "Cool drinking water is being arranged at the work area.",
        hi: "कार्य क्षेत्र में ठंडे पीने के पानी की व्यवस्था की जा रही है।",
        ar: "يجري توفير مياه شرب باردة في منطقة العمل.",
      },
      assignedRole: "supervisor",
      priority: "urgent",
      ackMinutes: 10,
      dueMinutes: 30,
    }),
    control({
      id: "provide_shade",
      title: "Provide shade for rest breaks",
      instructions: "The site record shows no shade. Set up shade close to the work area for rest breaks.",
      assignedRole: "supervisor",
      priority: "high",
      ackMinutes: 15,
      dueMinutes: 60,
    }),
    control({
      id: "cool_rest_area",
      title: "Set up a cool rest area",
      instructions: "Provide a cooled or well-ventilated rest area within easy reach of the work area.",
      assignedRole: "supervisor",
      priority: "high",
      ackMinutes: 15,
      dueMinutes: 90,
    }),
    control({
      id: "acclimatization_plan",
      title: "Apply the acclimatization plan",
      instructions:
        "New or returning workers need reduced heat exposure that increases gradually, as set out in the approved protocol. Adjust assignments now.",
      assignedRole: "supervisor",
      priority: "high",
      ackMinutes: 15,
      dueMinutes: 60,
    }),
    control({
      id: "stop_work_review",
      title: "Review stop-work decision",
      instructions:
        "Risk is at the protocol's human-review level. Decide with site management whether work must stop or change. HeatShield Shift does not make this decision.",
      worker: {
        en: "Work may pause. Stop and move to the rest area if your supervisor tells you to.",
        hi: "काम रुक सकता है। सुपरवाइज़र कहें तो काम रोककर आराम क्षेत्र में जाएँ।",
        ar: "قد يتوقف العمل. توقف وانتقل إلى منطقة الراحة إذا طلب منك المشرف ذلك.",
      },
      assignedRole: "safety_lead",
      priority: "urgent",
      ackMinutes: 10,
      dueMinutes: 30,
    }),
    control({
      id: "check_on_worker",
      title: "Someone needs help — go now",
      instructions:
        "A worker reported that someone may be unwell. Go to the location now, follow the site first-aid procedure, and call emergency services if symptoms are serious.",
      assignedRole: "supervisor",
      priority: "urgent",
      ackMinutes: 5,
      dueMinutes: 15,
    }),
    control({
      id: "fix_barrier",
      title: "Fix a reported problem",
      instructions:
        "A worker reported a missing protective facility. Check and fix it, or record why it can't be fixed so it can be escalated.",
      assignedRole: "supervisor",
      priority: "high",
      ackMinutes: 15,
      dueMinutes: 60,
    }),
  ],
};

export function levelRank(level) {
  return level === "unknown" ? -1 : LEVELS.indexOf(level);
}
