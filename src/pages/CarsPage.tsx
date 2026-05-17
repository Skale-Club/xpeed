import { useState } from 'react';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCarsContext } from '@/contexts/CarsContext';
import { PageLoader } from '@/components/PageLoader';
import { Car, Plus, Trash2, Edit2, Check, X, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export default function CarsPage() {
  const { cars, selectedCarId, selectCar, createCar, updateCar, deleteCar, loading } = useCarsContext();
  
  const { toast } = useToast();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editingCar, setEditingCar] = useState<string | null>(null);
  const [newCarName, setNewCarName] = useState('');
  const [newCarNotes, setNewCarNotes] = useState('');
  const [editName, setEditName] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);

  const handleCreateCar = async () => {
    if (!newCarName.trim()) {
      toast({ title: 'Error', description: 'Please enter a car name', variant: 'destructive' });
      return;
    }

    setIsCreating(true);
    try {
      await createCar(newCarName.trim(), newCarNotes.trim() || undefined);
      toast({ title: 'Success', description: 'Car added successfully' });
      setNewCarName('');
      setNewCarNotes('');
      setIsAddDialogOpen(false);
    } catch (error) {
      toast({ title: 'Error', description: String(error), variant: 'destructive' });
    } finally {
      setIsCreating(false);
    }
  };

  const handleUpdateCar = async (id: string) => {
    if (!editName.trim()) {
      toast({ title: 'Error', description: 'Please enter a car name', variant: 'destructive' });
      return;
    }

    setIsUpdating(true);
    try {
      await updateCar(id, { name: editName.trim(), notes: editNotes.trim() || null });
      toast({ title: 'Success', description: 'Car updated successfully' });
      setEditingCar(null);
    } catch (error) {
      toast({ title: 'Error', description: String(error), variant: 'destructive' });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDeleteCar = async (id: string) => {
    setIsDeleting(id);
    try {
      await deleteCar(id);
      toast({ title: 'Success', description: 'Car deleted successfully' });
    } catch (error) {
      toast({ title: 'Error', description: String(error), variant: 'destructive' });
    } finally {
      setIsDeleting(null);
    }
  };

  const startEditing = (car: { id: string; name: string; notes: string | null }) => {
    setEditingCar(car.id);
    setEditName(car.name);
    setEditNotes(car.notes || '');
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Car className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-mono font-bold text-foreground">My Vehicles</h2>
          </div>
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="font-mono text-xs">
                <Plus className="w-3.5 h-3.5 mr-2" />
                Add Vehicle
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add New Vehicle</DialogTitle>
                <DialogDescription>
                  Register a new vehicle to track its OBD2 data separately.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="car-name">Vehicle Name</Label>
                  <Input
                    id="car-name"
                    placeholder="e.g., 2015 Honda Civic"
                    value={newCarName}
                    onChange={(e) => setNewCarName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="car-notes">Notes (Optional)</Label>
                  <Input
                    id="car-notes"
                    placeholder="e.g., VIN, mileage, modifications..."
                    value={newCarNotes}
                    onChange={(e) => setNewCarNotes(e.target.value)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleCreateCar} disabled={isCreating}>
                  {isCreating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Add Vehicle
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {loading ? (
          <PageLoader fullScreen={false} className="py-12" />
        ) : cars.length === 0 ? (
          <Card className="bg-card border-border">
            <CardContent className="py-12 text-center">
              <Car className="w-12 h-12 text-primary/30 mx-auto mb-4" />
              <h3 className="text-sm font-mono font-semibold text-foreground mb-2">No Vehicles Yet</h3>
              <p className="text-xs text-muted-foreground mb-4">
                Add your first vehicle to start tracking OBD2 data.
              </p>
              <Button size="sm" onClick={() => setIsAddDialogOpen(true)}>
                <Plus className="w-3.5 h-3.5 mr-2" />
                Add Your First Vehicle
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {cars.map((car) => (
              <Card
                key={car.id}
                className={`group bg-card border-border cursor-pointer transition-all ${
                  selectedCarId === car.id ? 'ring-2 ring-primary' : 'hover:border-primary/50'
                }`}
                onClick={() => selectCar(car.id)}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                        <Car className="w-5 h-5 text-primary" />
                      </div>
                      <div>
                        {editingCar === car.id ? (
                          <div className="space-y-2">
                            <Input
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              className="h-7 text-sm"
                              placeholder="Car name"
                              onClick={(e) => e.stopPropagation()}
                            />
                            <Input
                              value={editNotes}
                              onChange={(e) => setEditNotes(e.target.value)}
                              className="h-6 text-xs"
                              placeholder="Notes"
                              onClick={(e) => e.stopPropagation()}
                            />
                          </div>
                        ) : (
                          <>
                            <CardTitle className="text-sm font-mono">{car.name}</CardTitle>
                            {car.notes && (
                              <p className="text-xs text-muted-foreground line-clamp-1">{car.notes}</p>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {editingCar === car.id ? (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleUpdateCar(car.id);
                            }}
                            disabled={isUpdating}
                          >
                            {isUpdating ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Check className="w-3.5 h-3.5 text-green-600" />
                            )}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingCar(null);
                            }}
                          >
                            <X className="w-3.5 h-3.5 text-destructive" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100"
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditing(car);
                            }}
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete Vehicle</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Are you sure you want to delete "{car.name}"? This will also delete all associated sessions and data.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => handleDeleteCar(car.id)}
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  disabled={isDeleting === car.id}
                                >
                                  {isDeleting === car.id && <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />}
                                  Delete
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  {selectedCarId === car.id && (
                    <div className="flex items-center gap-2 text-xs text-primary font-medium">
                      <Check className="w-3.5 h-3.5" />
                      Currently Selected
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
