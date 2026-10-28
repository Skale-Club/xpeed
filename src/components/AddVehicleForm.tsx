import { useTranslation } from 'react-i18next';
import { CarQuestions, type CarAnswers } from '@/components/CarQuestions';
import { useCarsContext } from '@/contexts/CarsContext';
import { useToast } from '@/hooks/use-toast';

interface AddVehicleFormProps {
  onSuccess: (carId: string) => void;
  onCancel: () => void;
}

/** Adds a car one question at a time; version, chassis and notes can be filled in later by editing. */
export function AddVehicleForm({ onSuccess, onCancel }: AddVehicleFormProps) {
  const { t } = useTranslation();
  const { createCar } = useCarsContext();
  const { toast } = useToast();

  const handleSubmit = async (answers: CarAnswers) => {
    const car = await createCar(answers);
    toast({ title: t('vehicle.added', 'Car added'), description: car.name });
    onSuccess(car.id);
  };

  return <CarQuestions onSubmit={handleSubmit} onExit={onCancel} />;
}
