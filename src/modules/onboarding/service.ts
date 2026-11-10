import type {OnboardingRepository} from './repository.js';
// Keep transaction/session authority inside the repository, including catalog-bound clients.
export function createOnboardingService(repository:OnboardingRepository){return repository;}
