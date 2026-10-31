import { expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, Link } from 'react-router-dom';
import { UnsavedChangesGuard } from './UnsavedChangesGuard';
import i18n from '@/lib/i18n';

it('blocks internal navigation until the user discards the dirty draft', async () => {
  await i18n.changeLanguage('en');
  const router = createMemoryRouter([{path:'/',element:<><UnsavedChangesGuard dirty /><Link to="/next">Next</Link></>},{path:'/next',element:<p>Destination</p>}]);
  render(<RouterProvider router={router} />);
  fireEvent.click(screen.getByRole('link',{name:'Next'}));
  expect(await screen.findByText('Leave without saving?')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/');
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  fireEvent.click(screen.getByRole('link',{name:'Next'}));
  fireEvent.click(await screen.findByRole('button',{name:'Discard changes'}));
  expect(await screen.findByText('Destination')).toBeInTheDocument();
});
