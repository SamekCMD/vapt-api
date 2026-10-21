import type {z} from 'zod';
import type {draftBasicsSchema,draftPatchSchema,guideModuleSchema} from './schemas.js';
export type DraftBasics=z.infer<typeof draftBasicsSchema>;
export type DraftPatch=z.infer<typeof draftPatchSchema>;
export type GuideModule=z.infer<typeof guideModuleSchema>;
export type OnboardingDraft={id:string;organizationId:string;name:string;slug:string;whatsapp:string;
  localEnabled:boolean;deliveryEnabled:boolean;totalTables:number;onboardingStep:0|1|2};
